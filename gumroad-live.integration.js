const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { createGumroadRouter } = require('./routes/gumroad.routes');
const { createSubscriptionMiddleware } = require('./middleware/subscription.middleware');
const { createAppConfig } = require('./app.config');
const { normalizeEmail } = require('./issuer-auth');
const { normalizePlanCode } = require('./services/gumroad.service');
const HANDOFF_LIFETIME_MS = 2 * 60 * 60 * 1000;

function createGumroadLiveIntegration({
  app,
  getService,
  getAccessModel,
  getDatabase,
  getAuth,
  getEntitlements,
  requireEmployer,
  setSessionCookie,
  getAuthService,
  resolveAuthAccount,
  setAuthSessionCookie,
  isSameOriginRequest = () => true,
  logger = console
}) {
  if (!app || typeof app.use !== 'function') throw new Error('An Express application is required.');
  if (typeof getService !== 'function' || typeof getAccessModel !== 'function' ||
      typeof getDatabase !== 'function' || typeof getAuth !== 'function' ||
      typeof getEntitlements !== 'function' || typeof requireEmployer !== 'function' ||
      (getAuthService && typeof getAuthService !== 'function') ||
      (resolveAuthAccount && typeof resolveAuthAccount !== 'function') ||
      (setAuthSessionCookie && typeof setAuthSessionCookie !== 'function')) {
    throw new Error('Gumroad integration dependencies and employer-session middleware are required.');
  }

  const employerIdsByEmail = new Map();
  let entitlementsBridgeInstalled = false;

  function accessStatusForEmployer(employerId) {
    const row = getAccessModel().findByEmployerId(employerId);
    const active = Boolean(row && row.status === 'active' && Date.parse(row.expiresAt) > Date.now());
    return { row, active };
  }

  function mappedEmployerIds(emails) {
    const ids = new Set();
    for (const email of emails || []) {
      const employerId = employerIdsByEmail.get(normalizeEmail(email));
      if (employerId) ids.add(employerId);
    }
    return [...ids];
  }

  function rememberEmployer(employerId, ...emails) {
    if (!employerId) return;
    for (const email of emails.flat().filter(Boolean)) {
      employerIdsByEmail.set(normalizeEmail(email), employerId);
    }
  }

  function installEntitlementsBridge() {
    if (entitlementsBridgeInstalled) return;
    const entitlements = getEntitlements();
    if (!entitlements) throw new Error('Employer entitlements are not initialized.');
    const originalGetStatus = entitlements.getStatus.bind(entitlements);
    const originalConsume = entitlements.consume.bind(entitlements);
    entitlements.getStatus = (emails) => {
      const base = originalGetStatus(emails);
      const gumroadAccesses = mappedEmployerIds(emails).map((employerId) => ({
        employerId,
        ...accessStatusForEmployer(employerId)
      }));
      const current = gumroadAccesses.find((entry) => entry.active);
      if (!current) {
        return { ...base, everPurchased: base.everPurchased || mappedEmployerIds(emails).length > 0 };
      }
      const plan = createAppConfig().plans[current.row.planCode];
      return {
        ...base,
        subscriptionActive: true,
        everPurchased: true,
        planTier: current.row.planCode,
        expiresAt: current.row.expiresAt,
        hasAccess: true,
        subscriptionExpired: false,
        expiredAt: null,
        gumroadPlanCode: current.row.planCode,
        gumroadLimits: { maxEmployees: plan.maxEmployees, maxLetters: plan.maxLetters }
      };
    };
    entitlements.consume = (emails) => {
      if (mappedEmployerIds(emails).some((employerId) => accessStatusForEmployer(employerId).active)) return true;
      return originalConsume(emails);
    };
    entitlementsBridgeInstalled = true;
  }

  async function initialize() {
    getDatabase().exec(`
      CREATE TABLE IF NOT EXISTS gumroad_auth_checkout_handoffs (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT,
        employer_id TEXT,
        officer_id TEXT,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS gumroad_auth_checkout_handoffs_by_expiry
        ON gumroad_auth_checkout_handoffs(expires_at);
    `);
    const auth = getAuth();
    const store = await auth.readStore();
    for (const employer of store.employers || []) {
      rememberEmployer(employer.id, employer.businessEmail, ...(employer.officers || []).map((officer) => officer.email));
    }
    installEntitlementsBridge();
  }

  function runMiddleware(req, res, next, middleware) {
    let index = 0;
    const dispatch = (error) => {
      if (error) return next(error);
      if (res.headersSent) return undefined;
      const current = middleware[index++];
      if (!current) return next();
      try {
        const result = current(req, res, dispatch);
        if (result && typeof result.catch === 'function') result.catch(next);
        return result;
      } catch (middlewareError) {
        return next(middlewareError);
      }
    };
    return dispatch();
  }

  function subscriptionMiddleware() {
    const database = getDatabase();
    const service = getService();
    if (!database || !service) throw new Error('Gumroad integration is not initialized.');
    return createSubscriptionMiddleware({
      service,
      logger,
      getUsageCount: (employerId, resource) => {
        const table = resource === 'letters' ? 'audit_logs' : 'i9_records';
        const result = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE employer_id = ?`).get(employerId);
        return result.count;
      }
    });
  }

  function gateResource(resource, countLimit) {
    return (req, res, next) => {
      let gates;
      try {
        const subscription = subscriptionMiddleware();
        gates = [
          requireEmployer,
          subscription.requireActiveGumroadPlan(),
          ...(countLimit ? [subscription.enforcePlanLimit(resource)] : [])
        ];
      } catch (error) {
        logger.error('Unable to initialize Gumroad access middleware:', error);
        return res.status(503).json({ success: false, message: 'Unable to verify subscription access.' });
      }
      return runMiddleware(req, res, next, gates);
    };
  }

  function sendFileWithScript(req, res, next) {
    const originalSendFile = res.sendFile.bind(res);
    res.sendFile = (filePath, options, callback) => {
      let sendOptions = options;
      let sendCallback = callback;
      if (typeof sendOptions === 'function') {
        sendCallback = sendOptions;
        sendOptions = undefined;
      }
      const file = typeof filePath === 'string' ? filePath : '';
      if (!file.toLowerCase().endsWith('.html')) {
        return originalSendFile(filePath, sendOptions, sendCallback);
      }
      fs.readFile(file, 'utf8').then((html) => {
        const script = '<script src="/public/gumroad-live.js" defer></script>';
        const updated = html.includes('</body>')
          ? html.replace('</body>', `${script}</body>`)
          : `${html}${script}`;
        res.setHeader('Cache-Control', 'no-store');
        return res.type('html').send(updated);
      }).catch((error) => {
        if (sendCallback) return sendCallback(error);
        logger.error('Unable to inject Gumroad page integration:', error);
        if (!res.headersSent) res.status(500).send('Unable to load the requested page.');
      });
      return res;
    };
    return next();
  }

  function createCheckoutHandoff(context) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + HANDOFF_LIFETIME_MS).toISOString();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    getDatabase().prepare('DELETE FROM gumroad_auth_checkout_handoffs WHERE expires_at <= ?').run(now.toISOString());
    getDatabase().prepare(`INSERT INTO gumroad_auth_checkout_handoffs
      (token_hash, account_id, employer_id, officer_id, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(tokenHash, context.accountId || null, context.employer?.id || null, context.officer?.id || null, expiresAt);
    return token;
  }

  function consumeCheckoutHandoff(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const database = getDatabase();
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      const handoff = database.prepare(`SELECT account_id AS accountId, employer_id AS employerId,
        officer_id AS officerId
        FROM gumroad_auth_checkout_handoffs WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
        .get(tokenHash, now);
      if (!handoff) {
        database.exec('COMMIT');
        return null;
      }
      const updated = database.prepare(`UPDATE gumroad_auth_checkout_handoffs SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL`).run(now, tokenHash);
      database.exec('COMMIT');
      return updated.changes === 1 ? handoff : null;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async function registerEmployer(req, res) {
    if (!isSameOriginRequest(req, res)) return res.status(403).json({ success: false, message: 'Cross-origin requests are not allowed.' });
    try {
      const input = req.body || {};
      const account = await getAuth().registerAccount(input, req.ip);
      const email = normalizeEmail(input.email);
      rememberEmployer(account.employerId, email);
      getAuth().sendWelcomeEmail({ email, fullName: String(input.fullName || '').trim() })
        .catch((error) => logger.error('Unable to send registration welcome email:', error.message));
      const session = await getAuth().issueSession(account.employerId, account.officerId);
      if (typeof setSessionCookie === 'function') setSessionCookie(res, session.token, req);
      const planCode = normalizePlanCode(input.plan);
      const selection = planCode ? `?plan=${encodeURIComponent(input.plan)}` : '';
      return res.status(201).json({
        success: true,
        redirectTo: `/select-plan${selection}`,
        subscriptionStatus: 'inactive',
        message: 'Account created.'
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async function checkout(req, res) {
    try {
      const context = await getAuth().getSession(req);
      res.setHeader('Cache-Control', 'no-store');
      if (!context) return res.redirect(`/register?plan=${encodeURIComponent(String(req.query.plan || ''))}`);
      const planCode = normalizePlanCode(req.query.plan);
      if (!planCode) return res.status(400).send('Choose a valid subscription plan.');
      const origin = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const handoff = createCheckoutHandoff(context);
      const returnUrl = new URL('/payment-success', origin);
      returnUrl.searchParams.set('handoff', handoff);
      const checkoutUrl = getService().createCheckoutUrl(planCode, context.officer.email, returnUrl.toString());
      try {
        await getService().trackEvent('gumroad_checkout_started', context.employer.id, { planCode });
      } catch (error) {
        logger.error('Unable to record Gumroad checkout analytics:', error);
      }
      return res.redirect(303, checkoutUrl);
    } catch (error) {
      logger.error('Unable to start Gumroad checkout:', error);
      return res.status(502).send('Unable to start checkout. Please try again.');
    }
  }

  async function paymentSuccess(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      let context = await getAuth().getSession(req);
      if (!context && req.query.handoff) {
        const handoff = consumeCheckoutHandoff(req.query.handoff);
        if (handoff) {
          if (handoff.accountId && getAuthService && setAuthSessionCookie && resolveAuthAccount) {
            const account = await getAuthService().findAccountById(handoff.accountId);
            if (!account) throw new Error('Checkout account no longer exists.');
            const session = await getAuthService().createSession(account.id);
            setAuthSessionCookie(res, session.sessionToken, req);
            context = await resolveAuthAccount(account);
          } else if (handoff.employerId && handoff.officerId) {
            const session = await getAuth().issueSession(handoff.employerId, handoff.officerId);
            if (typeof setSessionCookie === 'function') setSessionCookie(res, session.token, req);
            context = session;
          }
        }
      }
      if (!context) return res.redirect(`/login?next=${encodeURIComponent('/payment-success')}`);
      try {
        await getService().trackEvent('gumroad_payment_success_page_loaded', context.employer.id, {});
      } catch (error) {
        logger.error('Unable to record Gumroad payment-success analytics:', error);
      }
      const pagePath = path.join(__dirname, 'public', 'payment-success.html');
      return res.type('html').send(await fs.readFile(pagePath, 'utf8'));
    } catch (error) {
      logger.error('Unable to load Gumroad payment-success page:', error);
      return res.status(503).send('Unable to check payment status. Please try again.');
    }
  }

  app.use(['/register', '/select-plan', '/dashboard', '/create-letter', '/employees', '/letters'], sendFileWithScript);
  app.post('/api/employers', registerEmployer);
  app.get('/checkout', checkout);
  app.get('/payment-success', paymentSuccess);

  app.use('/api/i9/records', (req, res, next) => {
    if (req.method !== 'POST') return next();
    return gateResource('employees', true)(req, res, next);
  });
  app.use('/api/letters', (req, res, next) => {
    const isCreate = req.method === 'POST' && req.path === '/';
    const isExport = (req.method === 'GET' || req.method === 'POST') && /\/(?:export|email)$/.test(req.path);
    if (!isCreate && !isExport) return next();
    return gateResource('letters', isCreate)(req, res, next);
  });

  app.get('/employees', requireEmployer, (req, res) =>
    res.sendFile(path.join(__dirname, 'i9.html')));
  app.get('/letters', requireEmployer, (req, res) =>
    res.sendFile(path.join(__dirname, 'dashboard.html')));

  const serviceProxy = new Proxy({}, {
    get(_target, property) {
      const service = getService();
      if (!service) throw new Error('Gumroad service is not initialized.');
      const value = service[property];
      return typeof value === 'function' ? value.bind(service) : value;
    }
  });
  const router = createGumroadRouter({ service: serviceProxy, requireEmployer });
  app.use('/api/gumroad', router);

  return {
    initialize,
    rememberEmployer,
    get employerIdsByEmail() { return new Map(employerIdsByEmail); }
  };
}

module.exports = { createGumroadLiveIntegration };
