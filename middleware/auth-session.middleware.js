const SESSION_COOKIE = 'usevs_auth_session';
const { SESSION_LIFETIME_MS } = require('../services/auth.service');

function readSessionToken(request, cookieName = SESSION_COOKIE) {
  const cookieHeader = request.headers?.cookie;
  if (typeof cookieHeader !== 'string') return '';
  const prefix = `${cookieName}=`;
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!cookie) return '';
  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return '';
  }
}

function setSessionCookie(response, token, request, {
  cookieName = SESSION_COOKIE,
  sessionLifetimeMs = SESSION_LIFETIME_MS
} = {}) {
  const secure = request.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(sessionLifetimeMs / 1000)}${secure}`;
  const current = response.getHeader('Set-Cookie');
  response.setHeader('Set-Cookie', current ? [...(Array.isArray(current) ? current : [current]), cookie] : cookie);
}

function clearSessionCookie(response, request, cookieName = SESSION_COOKIE) {
  const secure = request.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const cookie = `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  const current = response.getHeader('Set-Cookie');
  response.setHeader('Set-Cookie', current ? [...(Array.isArray(current) ? current : [current]), cookie] : cookie);
}

function createAuthSessionMiddleware({
  authService,
  resolveAccountToEmployer,
  cookieName = SESSION_COOKIE,
  sessionLifetimeMs = SESSION_LIFETIME_MS,
  logger = console
} = {}) {
  if (!authService) throw new Error('An auth service is required.');

  async function attachAccountToRequest(req, res, next) {
    req.authSessionResolved = true;
    req.authSession = null;
    req.account = null;
    req.auth = null;
    req.issuerContext = null;
    const token = readSessionToken(req, cookieName);
    if (!token) return next();
    try {
      const session = await authService.validateSession(token);
      if (!session) {
        clearSessionCookie(res, req, cookieName);
        return next();
      }
      req.authSession = session;
      req.account = session.account;
      req.auth = { accountId: session.account.id, email: session.account.email };
      setSessionCookie(res, token, req, { cookieName, sessionLifetimeMs });
      if (typeof resolveAccountToEmployer === 'function') {
        req.issuerContext = await resolveAccountToEmployer(session.account);
        if (req.issuerContext?.employer?.id) req.auth.employerId = req.issuerContext.employer.id;
      }
      return next();
    } catch (error) {
      logger.error('Unable to validate foundation auth session:', error);
      return res.status(503).json({ success: false, message: 'Unable to validate your session.' });
    }
  }

  function requireAuth(req, res, next) {
    if (req.account) return next();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).json({
      success: false,
      message: 'Authentication is required.',
      redirectTo: '/login'
    });
  }

  return {
    attachAccountToRequest,
    clearSessionCookie: (res, req) => clearSessionCookie(res, req, cookieName),
    cookieName,
    readSessionToken: (req) => readSessionToken(req, cookieName),
    requireAuth,
    setSessionCookie: (res, token, req) => setSessionCookie(res, token, req, { cookieName, sessionLifetimeMs })
  };
}

module.exports = { SESSION_COOKIE, clearSessionCookie, createAuthSessionMiddleware, readSessionToken, setSessionCookie };
