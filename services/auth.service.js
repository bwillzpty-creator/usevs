const crypto = require('node:crypto');
const { normalizeEmail } = require('../issuer-auth');

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const PROVIDERS = new Set(['local', 'google', 'apple']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isUniqueConstraintError(error) {
  return error?.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(error?.message || '');
}

function sessionAccount(account) {
  const { passwordHash, ...safeAccount } = account;
  return { ...safeAccount, hasPassword: Boolean(passwordHash) };
}

function createAuthService({ accountModel, sessionModel, now = () => new Date(), sessionLifetimeMs = SESSION_LIFETIME_MS } = {}) {
  if (!accountModel || !sessionModel) throw new Error('Auth account and session models are required.');

  function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw new Error('Password must be between 12 and 128 characters.');
    }
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `$scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  function comparePassword(password, encoded) {
    if (typeof password !== 'string' || typeof encoded !== 'string') return false;
    const match = /^\$scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
    if (!match) return false;
    const [, nText, rText, pText, saltText, hashText] = match;
    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (n < 16384 || n > 262144 || (n & (n - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async function createLocalAccount(email, password) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail)) {
      throw new Error('A valid email address is required.');
    }
    const passwordHash = hashPassword(password);
    try {
      return accountModel.createLocal({
        id: crypto.randomUUID(),
        email: normalizedEmail,
        passwordHash,
        now: now().toISOString()
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new Error('An account with this email already exists.');
      throw error;
    }
  }

  async function linkLegacyAccount(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail)) {
      throw new Error('A valid linked account email is required.');
    }
    const existing = accountModel.findByEmail(normalizedEmail);
    if (existing) return existing;
    try {
      return accountModel.createSessionOnly({
        id: crypto.randomUUID(),
        email: normalizedEmail,
        now: now().toISOString()
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const account = accountModel.findByEmail(normalizedEmail);
        if (account) return account;
      }
      throw error;
    }
  }

  async function setPasswordForAccount(accountId, password) {
    const passwordHash = hashPassword(password);
    const changed = accountModel.setPasswordHash(accountId, passwordHash, now().toISOString());
    if (!changed) throw new Error('A password is already configured for this account.');
    return accountModel.findById(accountId);
  }

  async function createProviderAccount(provider, providerUserId, email) {
    const normalizedEmail = normalizeEmail(email);
    if (!PROVIDERS.has(provider) || provider === 'local') throw new Error('Unsupported identity provider.');
    if (typeof providerUserId !== 'string' || !providerUserId.trim() || providerUserId.length > 512) {
      throw new Error('A valid provider user ID is required.');
    }
    if (!normalizedEmail || normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail)) {
      throw new Error('A valid provider email address is required.');
    }
    try {
      return accountModel.createOrLinkProvider({
        id: crypto.randomUUID(),
        provider,
        providerUserId: providerUserId.trim(),
        email: normalizedEmail,
        now: now().toISOString()
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = accountModel.findByProviderUserId(provider, providerUserId);
        if (existing && existing.email === normalizedEmail) return existing;
        throw new Error('This provider identity or email is already linked.');
      }
      throw error;
    }
  }

  async function verifyPassword(email, password) {
    const normalizedEmail = normalizeEmail(email);
    const account = accountModel.findByEmail(normalizedEmail);
    if (!account || !account.passwordHash || !comparePassword(password, account.passwordHash)) return null;
    return account;
  }

  async function createSession(accountId) {
    const account = accountModel.findById(accountId);
    if (!account) throw new Error('The account does not exist.');
    const current = now();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const record = sessionModel.create({
      id: crypto.randomUUID(),
      accountId,
      sessionToken,
      expiresAt: new Date(current.getTime() + sessionLifetimeMs).toISOString(),
      createdAt: current.toISOString()
    });
    return { ...record, account: sessionAccount(account) };
  }

  async function validateSession(sessionToken) {
    const session = sessionModel.findByToken(sessionToken);
    if (!session) return null;
    const current = now();
    if (Date.parse(session.expiresAt) <= current.getTime()) {
      sessionModel.destroyById(session.id);
      return null;
    }
    const account = accountModel.findById(session.accountId);
    if (!account) {
      sessionModel.destroyById(session.id);
      return null;
    }
    const expiresAt = new Date(current.getTime() + sessionLifetimeMs).toISOString();
    sessionModel.refresh(session.id, expiresAt);
    return { ...session, expiresAt, account: sessionAccount(account) };
  }

  async function destroySession(sessionToken) {
    return sessionModel.destroy(sessionToken);
  }

  function createOAuthState(provider) {
    if (!['google', 'apple'].includes(provider)) throw new Error('Unsupported OAuth provider.');
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const createdAt = now();
    accountModel.createOAuthState({
      stateHash: hashToken(state),
      provider,
      nonce,
      expiresAt: new Date(createdAt.getTime() + OAUTH_STATE_LIFETIME_MS).toISOString(),
      createdAt: createdAt.toISOString()
    });
    return { state, nonce };
  }

  function consumeOAuthState(provider, state) {
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
    return accountModel.consumeOAuthState({
      stateHash: hashToken(state),
      provider,
      now: now().toISOString()
    });
  }

  return {
    comparePassword,
    consumeOAuthState,
    createLocalAccount,
    createOAuthState,
    createProviderAccount,
    createSession,
    destroySession,
    findAccountById: (id) => accountModel.findById(id),
    findAccountByEmail: (email) => accountModel.findByEmail(normalizeEmail(email)),
    hashPassword,
    linkLegacyAccount,
    setPasswordForAccount,
    validateSession,
    verifyPassword
  };
}

module.exports = { OAUTH_STATE_LIFETIME_MS, SESSION_LIFETIME_MS, createAuthService };
