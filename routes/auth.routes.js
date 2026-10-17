const express = require('express');
const { normalizeEmail } = require('../issuer-auth');
const { createProviderOAuthService } = require('../services/provider-oauth.service');

function oauthStateCookieName(provider) {
  return `usevs_oauth_${provider}_state`;
}

function readCookie(req, name) {
  const cookieHeader = req.headers?.cookie;
  if (typeof cookieHeader !== 'string') return '';
  const prefix = `${name}=`;
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!cookie) return '';
  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return '';
  }
}

function setOAuthStateCookie(res, req, provider, state) {
  const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${oauthStateCookieName(provider)}=${encodeURIComponent(state)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', current ? [...(Array.isArray(current) ? current : [current]), cookie] : cookie);
}

function clearOAuthStateCookie(res, req, provider) {
  const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${oauthStateCookieName(provider)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', current ? [...(Array.isArray(current) ? current : [current]), cookie] : cookie);
}

function createAuthRouter({
  authService,
  sessionMiddleware,
  providerOAuth,
  registerAccount,
  destroyLegacySession = async () => {},
  redirectForAccount = () => '/dashboard',
  env = process.env,
  isSameOriginRequest = () => true,
  logger = console
} = {}) {
  if (!authService || !sessionMiddleware) throw new Error('Auth service and session middleware are required.');
  const providers = providerOAuth || createProviderOAuthService({ env });
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));

  async function register(req, res) {
    if (!isSameOriginRequest(req, res)) return res.status(403).json({ success: false, message: 'Cross-origin requests are not allowed.' });
    try {
      const result = typeof registerAccount === 'function'
        ? await registerAccount(req, res)
        : { account: await authService.createLocalAccount(req.body?.email, req.body?.password), redirectTo: '/select-plan' };
      const session = await authService.createSession(result.account.id);
      sessionMiddleware.setSessionCookie(res, session.sessionToken, req);
      return res.status(201).json({
        success: true,
        account: { id: result.account.id, email: result.account.email, provider: result.account.provider },
        redirectTo: result.redirectTo || '/select-plan'
      });
    } catch (error) {
      const status = /already exists|already linked/i.test(error.message) ? 409 : 400;
      return res.status(status).json({ success: false, message: error.message });
    }
  }

  async function login(req, res, next) {
    if (!isSameOriginRequest(req, res)) return res.status(403).json({ success: false, message: 'Cross-origin requests are not allowed.' });
    try {
      const existingAccount = await authService.findAccountByEmail(req.body?.email);
      if (!existingAccount || !existingAccount.passwordHash) return next();
      const account = await authService.verifyPassword(req.body?.email, req.body?.password);
      if (!account) return res.status(401).json({ success: false, message: 'Email or password is incorrect.' });
      const session = await authService.createSession(account.id);
      sessionMiddleware.setSessionCookie(res, session.sessionToken, req);
      return res.json({
        success: true,
        account: { id: account.id, email: account.email, provider: account.provider },
        redirectTo: await redirectForAccount(account)
      });
    } catch (error) {
      logger.error('Foundation account sign-in failed:', error);
      return res.status(503).json({ success: false, message: 'Unable to sign in right now.' });
    }
  }

  async function logout(req, res) {
    if (!isSameOriginRequest(req, res)) return res.status(403).json({ success: false, message: 'Cross-origin requests are not allowed.' });
    const token = sessionMiddleware.readSessionToken
      ? sessionMiddleware.readSessionToken(req)
      : require('../middleware/auth-session.middleware').readSessionToken(req, sessionMiddleware.cookieName);
    try {
      await authService.destroySession(token);
      await destroyLegacySession(req, res);
      sessionMiddleware.clearSessionCookie(res, req);
      return res.json({ success: true });
    } catch (error) {
      logger.error('Unable to destroy foundation auth session:', error);
      return res.status(503).json({ success: false, message: 'Unable to sign out right now.' });
    }
  }

  function session(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.account) return res.status(401).json({ success: false, message: 'Authentication is required.' });
    return res.json({
      success: true,
      account: { id: req.account.id, email: req.account.email, provider: req.account.provider },
      employer: req.issuerContext?.employer || null,
      officer: req.issuerContext?.officer || null
    });
  }

  async function oauthStart(provider, req, res) {
    try {
      const { state, nonce } = authService.createOAuthState(provider);
      const origin = `${req.protocol}://${req.get('host')}`;
      const authorizationUrl = providers.getAuthorizationUrl(provider, { origin, state, nonce });
      setOAuthStateCookie(res, req, provider, state);
      return res.redirect(302, authorizationUrl);
    } catch (error) {
      logger.error(`Unable to start ${provider} sign-in:`, error);
      return res.status(503).send(`${provider === 'google' ? 'Google' : 'Apple'} sign-in is not configured.`);
    }
  }

  async function oauthCallback(provider, req, res) {
    const stateCookie = readCookie(req, oauthStateCookieName(provider));
    if (req.query.error) {
      clearOAuthStateCookie(res, req, provider);
      return res.redirect(`/login?provider_error=${encodeURIComponent(String(req.query.error).slice(0, 80))}`);
    }
    if (!stateCookie || stateCookie !== req.query.state) {
      clearOAuthStateCookie(res, req, provider);
      return res.status(400).send('The OAuth login state does not match this browser session.');
    }
    clearOAuthStateCookie(res, req, provider);
    const state = authService.consumeOAuthState(provider, req.query.state);
    if (!state) return res.status(400).send('The OAuth login state is invalid or expired.');
    if (typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) {
      return res.status(400).send('The OAuth authorization code is missing or invalid.');
    }
    try {
      const origin = `${req.protocol}://${req.get('host')}`;
      const redirectUri = providers.callbackUrl(provider, origin);
      const identity = provider === 'google'
        ? await providers.exchangeGoogleCode(req.query.code, redirectUri, state.nonce)
        : await providers.exchangeAppleCode(req.query.code, redirectUri, state.nonce);
      const account = await authService.createProviderAccount(provider, identity.providerUserId, normalizeEmail(identity.email));
      const createdSession = await authService.createSession(account.id);
      sessionMiddleware.setSessionCookie(res, createdSession.sessionToken, req);
      return res.redirect(303, await redirectForAccount(account));
    } catch (error) {
      logger.error(`${provider} sign-in callback failed:`, error);
      return res.redirect(`/login?provider_error=${encodeURIComponent('Unable to complete provider sign-in.')}`);
    }
  }

  router.post('/register', register);
  router.post('/login', login);
  router.post('/logout', (req, res, next) => req.account
    ? sessionMiddleware.requireAuth(req, res, next)
    : next(), logout);
  router.get('/session', session);
  router.get('/google/start', (req, res) => oauthStart('google', req, res));
  router.get('/google/callback', (req, res) => oauthCallback('google', req, res));
  router.get('/apple/start', (req, res) => oauthStart('apple', req, res));
  router.get('/apple/callback', (req, res) => oauthCallback('apple', req, res));
  return router;
}

module.exports = { createAuthRouter };
