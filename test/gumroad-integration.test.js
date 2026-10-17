const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { createEntitlements } = require('../entitlements');
const { createGumroadAccessModel } = require('../models/gumroad-access.model');
const { createGumroadEventModel } = require('../models/gumroad-event.model');
const { createGumroadService } = require('../services/gumroad.service');
const { createGumroadLiveIntegration } = require('../gumroad-live.integration');

const ENV = {
  GUMROAD_API_KEY: 'test-api-key',
  GUMROAD_SINGLE_USE_PRODUCT_ID: 'product-single',
  GUMROAD_MONTHLY_PRODUCT_ID: 'product-monthly',
  GUMROAD_YEARLY_PRODUCT_ID: 'product-yearly'
};

async function createIntegrationServer(t, actualProductId = 'product-monthly') {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE audit_logs (document_id TEXT, employer_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE i9_records (record_id TEXT, employer_id TEXT NOT NULL);
  `);
  const entitlements = createEntitlements(database);
  const accessModel = createGumroadAccessModel(database);
  const eventModel = createGumroadEventModel(database);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gumroad-integration-'));
  const trackedEvents = [];
  const employers = [];
  const sessionContext = {
    employer: { id: 'employer-1', businessEmail: 'hr@acme.example' },
    officer: { id: 'officer-1', email: 'hr@acme.example', fullName: 'Taylor Employer', title: 'HR Director' }
  };
  const auth = {
    async readStore() {
      return { employers: [...employers] };
    },
    async registerAccount(input) {
      employers.push({
        id: 'employer-1',
        businessEmail: input.email,
        officers: [{ email: input.email, id: 'officer-1' }]
      });
      return { employerId: 'employer-1', officerId: 'officer-1' };
    },
    async sendWelcomeEmail() {},
    async issueSession() {
      return { token: 'employer-session' };
    },
    async getSession(req) {
      return req.headers.cookie?.includes('session=employer-session') ? sessionContext : null;
    },
    async findOfficerByEmail(email) {
      return email.toLowerCase() === 'hr@acme.example'
        ? { employerId: 'employer-1', officerId: 'officer-1' }
        : null;
    }
  };
  const service = createGumroadService({
    accessModel,
    eventModel,
    env: ENV,
    now: () => new Date('2026-02-01T00:00:00.000Z'),
    eventStoragePath: path.join(directory, 'events'),
    resolveEmployerIdByEmail: async (email) => (await auth.findOfficerByEmail(email))?.employerId || null,
    analytics: async (event, distinctId, properties) => trackedEvents.push({ event, distinctId, properties }),
    fetchImpl: async (_url, options) => {
      const form = new URLSearchParams(options.body);
      const productId = form.get('product_id');
      if (productId !== actualProductId) return { ok: true, json: async () => ({ success: false }) };
      const purchase = {
        product_id: actualProductId,
        purchase_id: 'sale-live',
        license_key: 'license-live',
        email: 'hr@acme.example',
        created_at: '2026-02-01T00:00:00.000Z'
      };
      return { ok: true, json: async () => ({ success: true, purchase }) };
    }
  });
  const app = express();
  app.use(express.json());
  const requireEmployer = async (req, res, next) => {
    const context = await auth.getSession(req);
    if (!context) return res.status(401).json({ success: false, message: 'Session required.' });
    req.issuerContext = context;
    return next();
  };
  const integration = createGumroadLiveIntegration({
    app,
    getService: () => service,
    getAccessModel: () => accessModel,
    getDatabase: () => database,
    getAuth: () => auth,
    getEntitlements: () => entitlements,
    requireEmployer,
    setSessionCookie: (res, token) => res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly`),
    refreshSessionCookie() {},
    logger: { error() {} }
  });
  await integration.initialize();

  app.post('/api/letters', (req, res) => res.json({
    reachedLegacyHandler: true,
    entitlementAccess: entitlements.getStatus([sessionContext.officer.email]).hasAccess
  }));
  app.post('/api/i9/records', (req, res) => res.json({ reachedLegacyHandler: true }));
  app.get('/dashboard', (req, res) => res.sendFile(path.join(directory, 'dashboard.html')));
  await fs.writeFile(path.join(directory, 'dashboard.html'), '<!doctype html><body><main>History</main></body>');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { accessModel, auth, database, directory, entitlements, eventModel, origin, service, trackedEvents };
}

async function registerEmployer(origin, plan = 'monthly') {
  const response = await fetch(`${origin}/api/employers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Taylor Employer',
      email: 'hr@acme.example',
      organization: 'Acme',
      password: 'long-enough-password',
      plan
    }),
    redirect: 'manual'
  });
  return response;
}

test('registration redirects to plan selection and checkout redirects to Gumroad with employer email', async (t) => {
  const app = await createIntegrationServer(t);
  const registration = await registerEmployer(app.origin);
  assert.equal(registration.status, 201);
  const registered = await registration.json();
  assert.equal(registered.redirectTo, '/select-plan?plan=monthly');
  assert.equal(registered.subscriptionStatus, 'inactive');
  const cookie = registration.headers.get('set-cookie').split(';')[0];

  const checkout = await fetch(`${app.origin}/checkout?plan=monthly`, {
    headers: { Cookie: cookie },
    redirect: 'manual'
  });
  assert.equal(checkout.status, 303);
  const checkoutUrl = new URL(checkout.headers.get('location'));
  assert.equal(checkoutUrl.hostname, 'usevs.gumroad.com');
  assert.equal(checkoutUrl.searchParams.get('email'), 'hr@acme.example');
  const returnUrl = new URL(checkoutUrl.searchParams.get('redirect_url'));
  assert.equal(returnUrl.origin, app.origin);
  assert.equal(returnUrl.pathname, '/payment-success');
  assert.match(returnUrl.searchParams.get('handoff'), /^[A-Za-z0-9_-]{43}$/);
  const handoffPage = await fetch(returnUrl, { redirect: 'manual' });
  assert.equal(handoffPage.status, 200);
  assert.match(handoffPage.headers.get('set-cookie'), /session=employer-session/);
  assert.match(await handoffPage.text(), /Processing your subscription/);
  assert.ok(app.trackedEvents.some(({ event }) => event === 'gumroad_checkout_started'));
});

test('public Gumroad webhook activates a plan, authenticated access reports limits, and payment page waits', async (t) => {
  const app = await createIntegrationServer(t);
  const registration = await registerEmployer(app.origin);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const webhook = await fetch(`${app.origin}/api/gumroad/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sale_id: 'sale-live',
      license_key: 'license-live',
      product_id: 'product-monthly',
      email: 'hr@acme.example',
      purchase_time: '2026-02-01T00:00:00.000Z'
    })
  });
  assert.equal(webhook.status, 200);
  assert.equal((await webhook.json()).accepted, true);

  const access = await fetch(`${app.origin}/api/gumroad/access`, { headers: { Cookie: cookie } });
  assert.equal(access.status, 200);
  const accessBody = await access.json();
  assert.equal(accessBody.status, 'active');
  assert.equal(accessBody.planCode, 'monthly');
  assert.equal(accessBody.expiresAt, '2026-03-03T00:00:00.000Z');
  assert.equal(accessBody.limits.maxEmployees, 50);
  assert.equal(accessBody.limits.maxLetters, null);
  assert.ok(accessBody.gumroadLinks.monthly);

  const paymentPage = await fetch(`${app.origin}/payment-success`, { headers: { Cookie: cookie } });
  assert.equal(paymentPage.status, 200);
  const paymentHtml = await paymentPage.text();
  assert.match(paymentHtml, /Processing your subscription/);
  assert.match(paymentHtml, /\/create-letter/);
  assert.match(paymentHtml, /\/api\/gumroad\/access/);
  assert.ok(app.trackedEvents.some(({ event }) => event === 'gumroad_payment_success_page_loaded'));
});

test('expired plan returns the renewal banner and letter-creation guard stops the existing handler', async (t) => {
  const app = await createIntegrationServer(t);
  const registration = await registerEmployer(app.origin);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  await app.service.activatePlan(
    'employer-1', 'monthly', 'license-expired', 'sale-expired', '2026-01-31T23:59:59.000Z'
  );

  const access = await fetch(`${app.origin}/api/gumroad/access`, { headers: { Cookie: cookie } });
  assert.equal(access.status, 402);
  const accessBody = await access.json();
  assert.equal(accessBody.status, 'expired');
  assert.ok(accessBody.gumroadLinks.monthly);

  const letterCreation = await fetch(`${app.origin}/api/letters`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(letterCreation.status, 402);
  assert.deepEqual(await letterCreation.json(), {
    banner: 'Your subscription or pass has expired. You cannot generate new verification letters until you renew your subscription or buy a 1-day pass.',
    action: 'renew'
  });
  const history = await fetch(`${app.origin}/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(history.status, 200);
  assert.match(await history.text(), /History/);
});

test('single-use limits are enforced before live letter and employee handlers, while history remains view-only', async (t) => {
  const app = await createIntegrationServer(t, 'product-single');
  const registration = await registerEmployer(app.origin, '1day');
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  await app.service.activatePlan(
    'employer-1', 'single_use', 'license-single', 'sale-single', '2026-02-02T00:00:00.000Z'
  );
  app.database.prepare('INSERT INTO audit_logs (document_id, employer_id, status) VALUES (?, ?, ?)').run('letter-1', 'employer-1', 'verified');
  app.database.prepare('INSERT INTO i9_records (record_id, employer_id) VALUES (?, ?)').run('employee-1', 'employer-1');

  const letterLimit = await fetch(`${app.origin}/api/letters`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(letterLimit.status, 402);
  assert.match((await letterLimit.json()).message, /allows 1 letter/);

  const employeeLimit = await fetch(`${app.origin}/api/i9/records`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(employeeLimit.status, 402);
  assert.match((await employeeLimit.json()).message, /allows 1 employee/);

  const history = await fetch(`${app.origin}/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(history.status, 200);
  assert.match(await history.text(), /gumroad-live\.js/);
});

test('mounted employer routes require sessions, webhook does not, and wrappers continue to legacy handlers', async (t) => {
  const app = await createIntegrationServer(t);
  const anonymousAccess = await fetch(`${app.origin}/api/gumroad/access`);
  assert.equal(anonymousAccess.status, 401);

  const registration = await registerEmployer(app.origin);
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  await app.service.activatePlan(
    'employer-1', 'yearly', 'license-yearly', 'sale-yearly', '2027-02-01T00:00:00.000Z'
  );
  const letterCreation = await fetch(`${app.origin}/api/letters`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(letterCreation.status, 200);
  assert.equal((await letterCreation.json()).reachedLegacyHandler, true);

  const pageWithoutSession = await fetch(`${app.origin}/payment-success`, { redirect: 'manual' });
  assert.equal(pageWithoutSession.status, 302);
  assert.match(pageWithoutSession.headers.get('location'), /\/login\?next=/);

  const integrationSource = await fs.readFile(path.join(__dirname, '..', 'gumroad-live.integration.js'), 'utf8');
  assert.equal(integrationSource.includes("require('./server')"), false);
});
