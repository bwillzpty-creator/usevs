const crypto = require('node:crypto');
const path = require('node:path');
const { createAuthRouter } = require('./routes/auth.routes');
const { createAuthSessionMiddleware } = require('./middleware/auth-session.middleware');
const { normalizeEmail, SESSION_COOKIE: LEGACY_SESSION_COOKIE } = require('./issuer-auth');

function createAuthLiveIntegration({
  app,
  getAuthService,
  getProviderOAuth,
  getDatabase,
  employerAuth,
  rememberEmployer = () => {},
  isSameOriginRequest = () => true,
  logger = console,
  publicDirectory = path.join(__dirname, 'public')
}) {
  if (!app || typeof app.use !== 'function' || typeof getAuthService !== 'function' ||
      typeof getDatabase !== 'function' || !employerAuth) {
    throw new Error('Auth integration requires an application, foundation services, and employer profile store.');
  }

  const serviceProxy = new Proxy({}, {
    get(_target, property) {
      const service = getAuthService();
      if (!service) throw new Error('Foundation auth service is not initialized.');
      const value = service[property];
      return typeof value === 'function' ? value.bind(service) : value;
    }
  });
  const sessionMiddleware = createAuthSessionMiddleware({
    authService: serviceProxy,
    logger
  });

  async function resolveAccountToEmployer(account) {
    const email = normalizeEmail(account?.email);
    if (!email) return null;
    const store = await employerAuth.readStore();
    for (const employer of store.employers || []) {
      const officer = (employer.officers || []).find((entry) =>
        normalizeEmail(entry.email) === email && entry.active);
      if (!officer || employer.status !== 'verified') continue;
      rememberEmployer(employer.id, employer.businessEmail, officer.email);
      return {
        accountId: account.id,
        employer: employerAuth.publicEmployer(employer),
        officer: employerAuth.publicOfficer(officer)
      };
    }
    return null;
  }

  async function attachFoundationAccount(req, res, next) {
    return sessionMiddleware.attachAccountToRequest(req, res, async (error) => {
      if (error) return next(error);
      try {
        if (req.account) {
          req.issuerContext = await resolveAccountToEmployer(req.account);
          req.auth = {
            accountId: req.account.id,
            email: req.account.email,
            employerId: req.issuerContext?.employer?.id
          };
        } else {
          const legacyContext = await legacyGetSession(req);
          if (legacyContext) {
            const account = await getAuthService().linkLegacyAccount(legacyContext.officer.email);
            const session = await getAuthService().createSession(account.id);
            sessionMiddleware.setSessionCookie(res, session.sessionToken, req);
            req.authSession = session;
            req.account = account;
            req.issuerContext = await resolveAccountToEmployer(account);
            req.auth = {
              accountId: account.id,
              email: account.email,
              employerId: req.issuerContext?.employer?.id
            };
          } else {
            req.issuerContext = null;
            req.auth = null;
          }
        }
        return next();
      } catch (resolveError) {
        logger.error('Unable to link auth account to employer profile:', resolveError);
        return res.status(503).json({ success: false, message: 'Unable to load the employer profile.' });
      }
    });
  }

  const legacyGetSession = employerAuth.getSession.bind(employerAuth);
  employerAuth.getSession = async (req) => {
    if (req?.authSessionResolved) return req.issuerContext || null;
    return legacyGetSession(req);
  };

  async function registerEmployer(req) {
    const input = req.body || {};
    const email = normalizeEmail(input.email || req.account?.email);
    if (!email) throw new Error('A valid email address is required.');
    if (req.account && normalizeEmail(req.account.email) !== email) {
      throw new Error('The registered email must match the signed-in account.');
    }

    let profile = await employerAuth.findOfficerByEmail(email);
    let account = req.account;
    if (!account) {
      const existingAccount = await getAuthService().findAccountByEmail(email);
      if (existingAccount) throw new Error('An account with this email already exists. Sign in instead.');
      if (profile) {
        const legacyContext = await legacyGetSession(req);
        if (!legacyContext || normalizeEmail(legacyContext.officer.email) !== email) {
          throw new Error('Sign in to your existing employer account before linking it.');
        }
      }
      account = await getAuthService().createLocalAccount(email, input.password);
    } else if (!account.hasPassword && input.password) {
      account = await getAuthService().setPasswordForAccount(account.id, input.password);
    }
    if (!profile) {
      const profilePassword = req.account
        ? crypto.randomBytes(32).toString('base64url')
        : input.password;
      profile = await employerAuth.registerAccount({
        fullName: input.fullName,
        email,
        organization: input.organization,
        password: profilePassword
      }, req.ip);
    }
    rememberEmployer(profile.employerId, email);
    const plan = ['1day', 'monthly', 'yearly'].includes(input.plan) ? input.plan : '';
    return { account, redirectTo: `/select-plan${plan ? `?plan=${encodeURIComponent(plan)}` : ''}` };
  }

  async function redirectForAccount(account) {
    const profile = await resolveAccountToEmployer(account);
    return profile ? '/dashboard' : `/register?complete=1&email=${encodeURIComponent(account.email)}`;
  }

  async function loadPage(res, fileName) {
    try {
      const filePath = path.join(publicDirectory, fileName);
      const content = await require('node:fs/promises').readFile(filePath, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      return res.type('html').send(content);
    } catch (error) {
      logger.error(`Unable to serve foundation ${fileName}:`, error);
      return res.status(500).send('Unable to load the requested page.');
    }
  }

  const router = createAuthRouter({
    authService: serviceProxy,
    sessionMiddleware,
    providerOAuth: getProviderOAuth?.(),
    registerAccount: registerEmployer,
    destroyLegacySession: (req, res) => {
      employerAuth.logout(req);
      const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
      const cookie = `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
      const current = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', current ? [...(Array.isArray(current) ? current : [current]), cookie] : cookie);
    },
    redirectForAccount,
    isSameOriginRequest,
    logger
  });

  app.use(attachFoundationAccount);
  app.use('/api/auth', router);
  app.get('/login', (_req, res) => loadPage(res, 'login.html'));
  app.get('/register', (_req, res) => loadPage(res, 'register.html'));

  async function initialize() {
    if (!getDatabase()) throw new Error('Auth database is not initialized.');
    return resolveAccountToEmployer;
  }

  return {
    initialize,
    resolveAccountToEmployer,
    sessionMiddleware
  };
}

module.exports = { createAuthLiveIntegration };
