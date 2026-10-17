const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { createAuthLiveIntegration } = require('../auth-live.integration');
const { createAuthAccountModel } = require('../models/auth-account.model');
const { createAuthSessionModel } = require('../models/auth-session.model');
const { createAuthSessionMiddleware } = require('../middleware/auth-session.middleware');
const { createSubscriptionMiddleware } = require('../middleware/subscription.middleware');
const { createAuthRouter } = require('../routes/auth.routes');
const { createAuthService } = require('../services/auth.service');
const { createProviderOAuthService } = require('../services/provider-oauth.service');
const { EXPIRED_BANNER } = require('../app.config');
const { createEntitlements } = require('../entitlements');
const { createGumroadAccessModel } = require('../models/gumroad-access.model');
const { createGumroadEventModel } = require('../models/gumroad-event.model');
const { createGumroadLiveIntegration } = require('../gumroad-live.integration');
const { setSessionCookie } = require('../middleware/auth-session.middleware');

const PASSWORD = 'correct horse battery staple';

function createHarness(t, { now, providerOAuth, registerAccount } = {}) {
  const database = new DatabaseSync(':memory:');
  const accountModel = createAuthAccountModel(database);
  const sessionModel = createAuthSessionModel(database);
  const authService = createAuthService({ accountModel, sessionModel, now });
  const sessionMiddleware = createAuthSessionMiddleware({ authService });
  const app = express();
  app.use(express.json());
  app.use(sessionMiddleware.attachAccountToRequest);
  app.use('/api/auth', createAuthRouter({
    authService,
    sessionMiddleware,
    providerOAuth,
    registerAccount
  }));
  const server = http.createServer(app);
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      accountModel,
      authService,
      database,
      origin: `http://127.0.0.1:${server.address().port}`,
      sessionModel
    }));
  });
}

async function postJson(origin, route, body, cookie) {
  return fetch(`${origin}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body),
    redirect: 'manual'
  });
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';')[0];
}

test('local registration, password hashing, session validation, and logout work through auth routes', async (t) => {
  const harness = await createHarness(t);
  const registration = await postJson(harness.origin, '/api/auth/register', {
    email: 'Recruiter@Acme.example',
    password: PASSWORD
  });
  assert.equal(registration.status, 201);
  const registered = await registration.json();
  assert.equal(registered.redirectTo, '/select-plan');
  assert.equal(registered.account.email, 'recruiter@acme.example');
  const registrationCookie = cookieFrom(registration);
  assert.match(registration.headers.get('set-cookie'), /HttpOnly/);
  assert.match(registration.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal(harness.authService.comparePassword(PASSWORD, harness.accountModel.findByEmail('recruiter@acme.example').passwordHash), true);
  assert.notEqual(harness.accountModel.findByEmail('recruiter@acme.example').passwordHash, PASSWORD);
  const storedToken = harness.database.prepare('SELECT session_token FROM auth_sessions').get().session_token;
  assert.notEqual(storedToken, registrationCookie.split('=')[1]);

  const duplicate = await postJson(harness.origin, '/api/auth/register', {
    email: 'RECRUITER@ACME.EXAMPLE',
    password: PASSWORD
  });
  assert.equal(duplicate.status, 409);

  const sessionResponse = await fetch(`${harness.origin}/api/auth/session`, {
    headers: { Cookie: registrationCookie }
  });
  assert.equal(sessionResponse.status, 200);
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.account.email, 'recruiter@acme.example');
  assert.equal(Object.hasOwn(sessionBody.account, 'passwordHash'), false);

  const login = await postJson(harness.origin, '/api/auth/login', {
    email: 'RECRUITER@ACME.EXAMPLE',
    password: PASSWORD
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).redirectTo, '/dashboard');
  assert.ok(cookieFrom(login));

  const logout = await postJson(harness.origin, '/api/auth/logout', {}, registrationCookie);
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).success, true);
  assert.equal((await fetch(`${harness.origin}/api/auth/session`, {
    headers: { Cookie: registrationCookie }
  })).status, 401);
});

test('Google authorization-code exchange verifies the signed identity token and loads the profile', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nowSeconds = 1_800_000_000;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'google-test-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    aud: 'google-client',
    email: 'google@acme.example',
    email_verified: true,
    exp: nowSeconds + 600,
    iat: nowSeconds,
    iss: 'https://accounts.google.com',
    nonce: 'expected-nonce',
    sub: 'google-123'
  })).toString('base64url');
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  const idToken = `${signingInput}.${signature}`;
  const requests = [];
  let responseIdToken = idToken;
  const providerOAuth = createProviderOAuthService({
    env: { GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret' },
    nowSeconds: () => nowSeconds,
    async fetchImpl(url, options = {}) {
      requests.push({ url, options });
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'google-access-token', id_token: responseIdToken });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return jsonResponse({ keys: [{ ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'google-test-key' }] });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return jsonResponse({ email: 'google@acme.example', email_verified: true, sub: 'google-123' });
      }
      throw new Error(`Unexpected Google OAuth request: ${url}`);
    }
  });

  const identity = await providerOAuth.exchangeGoogleCode(
    'authorization-code',
    'https://app.example/api/auth/google/callback',
    'expected-nonce'
  );
  assert.deepEqual(identity, {
    provider: 'google',
    providerUserId: 'google-123',
    email: 'google@acme.example'
  });
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[2].options.headers.Authorization, 'Bearer google-access-token');

  responseIdToken = `${signingInput}.${Buffer.alloc(256).toString('base64url')}`;
  await assert.rejects(
    providerOAuth.exchangeGoogleCode('tampered-code', 'https://app.example/callback', 'expected-nonce'),
    /signature is invalid/
  );
});

test('session expiration invalidates the token and removes its database record', async (t) => {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const harness = await createHarness(t, { now: () => new Date(clock) });
  const account = await harness.authService.createLocalAccount('session@acme.example', PASSWORD);
  const session = await harness.authService.createSession(account.id);
  assert.ok(await harness.authService.validateSession(session.sessionToken));

  clock = new Date(Date.parse(session.expiresAt) + 1);
  assert.equal(await harness.authService.validateSession(session.sessionToken), null);
  assert.equal(harness.sessionModel.findByToken(session.sessionToken), null);
});

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

test('Google and Apple OAuth callbacks create provider accounts and secure sessions', async (t) => {
  const providerOAuth = {
    getAuthorizationUrl(provider, { state, nonce }) {
      return `https://identity.example/${provider}?state=${encodeURIComponent(state)}&nonce=${encodeURIComponent(nonce)}`;
    },
    callbackUrl(provider) {
      return `https://app.example/api/auth/${provider}/callback`;
    },
    async exchangeGoogleCode() {
      return { providerUserId: 'google-123', email: 'google@acme.example' };
    },
    async exchangeAppleCode() {
      return { providerUserId: 'apple-456', email: 'apple@acme.example' };
    }
  };
  const harness = await createHarness(t, { providerOAuth });

  for (const [provider, email, identity] of [
    ['google', 'google@acme.example', 'google-123'],
    ['apple', 'apple@acme.example', 'apple-456']
  ]) {
    const start = await fetch(`${harness.origin}/api/auth/${provider}/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get('location'));
    const stateCookie = cookieFrom(start);
    const callback = await fetch(`${harness.origin}/api/auth/${provider}/callback?code=mock-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`, {
      headers: { Cookie: stateCookie },
      redirect: 'manual'
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/dashboard');
    assert.match(callback.headers.get('set-cookie'), /HttpOnly/);
    assert.equal(harness.accountModel.findByProviderUserId(provider, identity).email, email);
  }
});

test('foundation sessions resolve to Gumroad employer access and enforce plan limits', async (t) => {
  const database = new DatabaseSync(':memory:');
  const accountModel = createAuthAccountModel(database);
  const sessionModel = createAuthSessionModel(database);
  const authService = createAuthService({ accountModel, sessionModel });
  const employer = {
    id: 'employer-1',
    legalName: 'Acme',
    businessEmail: 'hr@acme.example',
    status: 'verified',
    officers: [{ id: 'officer-1', email: 'hr@acme.example', fullName: 'Recruiter', title: 'HR', active: true }]
  };
  const employerAuth = {
    async readStore() { return { employers: [employer] }; },
    publicEmployer(value) { return { id: value.id, businessEmail: value.businessEmail }; },
    publicOfficer(value) { return { id: value.id, email: value.email, fullName: value.fullName }; },
    async getSession() { return null; }
  };
  const app = express();
  app.use(express.json());
  const integration = createAuthLiveIntegration({
    app,
    getAuthService: () => authService,
    getProviderOAuth: () => ({
      getAuthorizationUrl() { return 'https://identity.example'; },
      callbackUrl() { return 'https://app.example/callback'; }
    }),
    getDatabase: () => database,
    employerAuth
  });
  await integration.initialize();

  let access = {
    active: true,
    status: 'active',
    planCode: 'single_use',
    expiresAt: '2026-01-02T00:00:00.000Z',
    limits: { maxEmployees: 1, maxLetters: 1 }
  };
  let usageCount = 0;
  const subscription = createSubscriptionMiddleware({
    service: {
      async getAccessStatus() { return access; },
      async trackEvent() {}
    },
    getUsageCount: async () => usageCount,
    logger: { error() {} }
  });
  app.get('/test/employee', subscription.requireActiveGumroadPlan(), subscription.enforcePlanLimit('employees'), (req, res) => res.json({
    allowed: true,
    employerId: req.issuerContext.employer.id
  }));

  const account = await authService.createLocalAccount('hr@acme.example', PASSWORD);
  const session = await authService.createSession(account.id);
  const server = http.createServer(app);
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/test/employee`;
  const cookie = `usevs_auth_session=${encodeURIComponent(session.sessionToken)}`;

  const allowed = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { allowed: true, employerId: 'employer-1' });

  usageCount = 1;
  const limited = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(limited.status, 402);
  assert.equal((await limited.json()).message, 'Your single_use plan allows 1 employee.');

  access = { ...access, active: false, status: 'expired' };
  const expired = await fetch(url, { headers: { Cookie: cookie } });
  assert.equal(expired.status, 402);
  assert.equal((await expired.json()).banner, EXPIRED_BANNER);
});

test('verified legacy sessions are linked to foundation sessions and logout clears both', async (t) => {
  const database = new DatabaseSync(':memory:');
  const accountModel = createAuthAccountModel(database);
  const sessionModel = createAuthSessionModel(database);
  const authService = createAuthService({ accountModel, sessionModel });
  const employer = {
    id: 'legacy-employer',
    businessEmail: 'legacy@acme.example',
    status: 'verified',
    officers: [{ id: 'legacy-officer', email: 'legacy@acme.example', fullName: 'Legacy Recruiter', title: 'HR', active: true }]
  };
  let legacyLogoutCalled = false;
  const legacyContext = {
    employer: { id: employer.id, businessEmail: employer.businessEmail },
    officer: { id: 'legacy-officer', email: 'legacy@acme.example', fullName: 'Legacy Recruiter', title: 'HR' }
  };
  const employerAuth = {
    async readStore() { return { employers: [employer] }; },
    publicEmployer(value) { return { id: value.id, businessEmail: value.businessEmail }; },
    publicOfficer(value) { return { id: value.id, email: value.email, fullName: value.fullName }; },
    async getSession(req) { return req.headers.cookie?.includes('legacy_session=valid') ? legacyContext : null; },
    logout() { legacyLogoutCalled = true; }
  };
  const app = express();
  app.use(express.json());
  createAuthLiveIntegration({
    app,
    getAuthService: () => authService,
    getProviderOAuth: () => ({
      getAuthorizationUrl() { return 'https://identity.example'; },
      callbackUrl() { return 'https://app.example/callback'; }
    }),
    getDatabase: () => database,
    employerAuth
  });
  const server = http.createServer(app);
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const sessionResponse = await fetch(`${origin}/api/auth/session`, {
    headers: { Cookie: 'legacy_session=valid' }
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.account.email, 'legacy@acme.example');
  assert.equal(session.employer.id, employer.id);
  assert.match(sessionResponse.headers.get('set-cookie'), /usevs_auth_session=/);
  assert.equal(accountModel.findByEmail('legacy@acme.example').passwordHash, null);

  const foundationCookie = cookieFrom(sessionResponse);
  const logout = await postJson(origin, '/api/auth/logout', {}, `legacy_session=valid; ${foundationCookie}`);
  assert.equal(logout.status, 200);
  assert.equal(legacyLogoutCalled, true);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('Gumroad checkout return restores a foundation session without relying on cross-site cookies', async (t) => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE audit_logs (employer_id TEXT NOT NULL); CREATE TABLE i9_records (employer_id TEXT NOT NULL);');
  const accountModel = createAuthAccountModel(database);
  const sessionModel = createAuthSessionModel(database);
  const authService = createAuthService({ accountModel, sessionModel });
  const accessModel = createGumroadAccessModel(database);
  const eventModel = createGumroadEventModel(database);
  const entitlements = createEntitlements(database);
  const employer = {
    id: 'checkout-employer',
    businessEmail: 'checkout@acme.example',
    status: 'verified',
    officers: [{ id: 'checkout-officer', email: 'checkout@acme.example', fullName: 'Checkout Recruiter', title: 'HR', active: true }]
  };
  const employerAuth = {
    async readStore() { return { employers: [employer] }; },
    async getSession() { return null; },
    publicEmployer(value) { return { id: value.id, businessEmail: value.businessEmail }; },
    publicOfficer(value) { return { id: value.id, email: value.email, fullName: value.fullName }; }
  };
  const app = express();
  app.use(express.json());
  const authIntegration = createAuthLiveIntegration({
    app,
    getAuthService: () => authService,
    getProviderOAuth: () => ({
      getAuthorizationUrl() { return 'https://identity.example'; },
      callbackUrl() { return 'https://app.example/callback'; }
    }),
    getDatabase: () => database,
    employerAuth
  });
  const tracked = [];
  const gumroadService = {
    createCheckoutUrl(_plan, email, returnUrl) {
      return `https://usevs.gumroad.com/checkout?email=${encodeURIComponent(email)}&redirect_url=${encodeURIComponent(returnUrl)}`;
    },
    async trackEvent(event, distinctId) { tracked.push({ event, distinctId }); },
    async getAccessStatus(employerId) {
      return {
        active: true,
        status: 'active',
        employerId,
        planCode: 'monthly',
        expiresAt: '2026-08-01T00:00:00.000Z',
        limits: { maxEmployees: 50, maxLetters: null }
      };
    }
  };
  const gumroadIntegration = createGumroadLiveIntegration({
    app,
    getService: () => gumroadService,
    getAccessModel: () => accessModel,
    getDatabase: () => database,
    getAuth: () => employerAuth,
    getAuthService: () => authService,
    resolveAuthAccount: (account) => authIntegration.resolveAccountToEmployer(account),
    getEntitlements: () => entitlements,
    requireEmployer: async (req, res, next) => {
      req.issuerContext = await employerAuth.getSession(req);
      if (!req.issuerContext) return res.status(401).json({ success: false });
      return next();
    },
    setAuthSessionCookie: (res, token, req) => setSessionCookie(res, token, req),
    logger: { error() {} }
  });
  await authIntegration.initialize();
  await gumroadIntegration.initialize();

  const account = await authService.createLocalAccount('checkout@acme.example', PASSWORD);
  const session = await authService.createSession(account.id);
  const server = http.createServer(app);
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const checkout = await fetch(`${origin}/checkout?plan=monthly`, {
    headers: { Cookie: `usevs_auth_session=${encodeURIComponent(session.sessionToken)}` },
    redirect: 'manual'
  });
  assert.equal(checkout.status, 303);
  const checkoutUrl = new URL(checkout.headers.get('location'));
  const returnUrl = new URL(checkoutUrl.searchParams.get('redirect_url'));
  const paymentSuccess = await fetch(`${origin}${returnUrl.pathname}${returnUrl.search}`, { redirect: 'manual' });
  assert.equal(paymentSuccess.status, 200);
  assert.match(await paymentSuccess.text(), /Processing your subscription/);
  assert.match(paymentSuccess.headers.get('set-cookie'), /usevs_auth_session=/);
  assert.ok(tracked.some((entry) => entry.event === 'gumroad_payment_success_page_loaded'));

  const returnedSessionCookie = cookieFrom(paymentSuccess);
  const access = await fetch(`${origin}/api/gumroad/access`, {
    headers: { Cookie: returnedSessionCookie }
  });
  assert.equal(access.status, 200);
  assert.equal((await access.json()).active, true);
});
