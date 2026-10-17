const PROVIDERS = new Set(['local', 'google', 'apple']);

function createAuthAccountModel(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT,
      provider TEXT NOT NULL CHECK (provider IN ('local', 'google', 'apple')),
      provider_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, provider_user_id)
    );
    CREATE TABLE IF NOT EXISTS auth_provider_identities (
      provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
      provider_user_id TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, provider_user_id)
    );
    CREATE INDEX IF NOT EXISTS auth_provider_identities_by_account
      ON auth_provider_identities(account_id);
    CREATE TABLE IF NOT EXISTS auth_oauth_states (
      state_hash TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('google', 'apple')),
      nonce TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_oauth_states_by_expiry ON auth_oauth_states(expires_at);
  `);

  const fields = `id, email, password_hash AS passwordHash, provider,
    provider_user_id AS providerUserId, created_at AS createdAt, updated_at AS updatedAt`;

  function findById(id) {
    return database.prepare(`SELECT ${fields} FROM auth_accounts WHERE id = ?`).get(id) || null;
  }

  function findByEmail(email) {
    return database.prepare(`SELECT ${fields} FROM auth_accounts WHERE email = ? COLLATE NOCASE`).get(email) || null;
  }

  function findByProviderUserId(provider, providerUserId) {
    if (!PROVIDERS.has(provider) || provider === 'local' || !providerUserId) return null;
    return database.prepare(`SELECT a.id, a.email, a.password_hash AS passwordHash, a.provider,
      a.provider_user_id AS providerUserId, a.created_at AS createdAt, a.updated_at AS updatedAt,
      i.provider AS linkedProvider,
      i.provider_user_id AS linkedProviderUserId
      FROM auth_provider_identities i JOIN auth_accounts a ON a.id = i.account_id
      WHERE i.provider = ? AND i.provider_user_id = ?`)
      .get(provider, providerUserId) || null;
  }

  function createLocal({ id, email, passwordHash, now }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!id || !normalizedEmail || !passwordHash || !now) throw new Error('Local account details are incomplete.');
    database.prepare(`INSERT INTO auth_accounts
      (id, email, password_hash, provider, provider_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'local', NULL, ?, ?)`).run(id, normalizedEmail, passwordHash, now, now);
    return findById(id);
  }

  function createSessionOnly({ id, email, now }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!id || !normalizedEmail || !now) throw new Error('Linked account details are incomplete.');
    database.prepare(`INSERT INTO auth_accounts
      (id, email, password_hash, provider, provider_user_id, created_at, updated_at)
      VALUES (?, ?, NULL, 'local', NULL, ?, ?)`).run(id, normalizedEmail, now, now);
    return findById(id);
  }

  function setPasswordHash(id, passwordHash, now) {
    return database.prepare(`UPDATE auth_accounts SET password_hash = ?, updated_at = ?
      WHERE id = ? AND password_hash IS NULL`).run(passwordHash, now, id).changes === 1;
  }

  function createOrLinkProvider({ id, provider, providerUserId, email, now }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!id || !PROVIDERS.has(provider) || provider === 'local' || !providerUserId || !normalizedEmail || !now) {
      throw new Error('Provider account details are incomplete.');
    }
    const byIdentity = findByProviderUserId(provider, providerUserId);
    if (byIdentity) {
      if (byIdentity.email.toLowerCase() !== normalizedEmail) {
        throw new Error('The provider identity is already linked to another email address.');
      }
      return byIdentity;
    }

    let account = findByEmail(normalizedEmail);
    if (!account) {
      database.prepare(`INSERT INTO auth_accounts
        (id, email, password_hash, provider, provider_user_id, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?)`).run(id, normalizedEmail, provider, providerUserId, now, now);
      account = findById(id);
    } else if (account.provider === provider && account.providerUserId && account.providerUserId !== providerUserId) {
      throw new Error('This email is already linked to a different identity from this provider.');
    }

    database.prepare(`INSERT INTO auth_provider_identities (provider, provider_user_id, account_id, created_at)
      VALUES (?, ?, ?, ?)`).run(provider, providerUserId, account.id, now);
    database.prepare('UPDATE auth_accounts SET updated_at = ? WHERE id = ?').run(now, account.id);
    return findById(account.id);
  }

  function createOAuthState({ stateHash, provider, nonce, expiresAt, createdAt }) {
    if (!stateHash || !['google', 'apple'].includes(provider) || !nonce || !expiresAt || !createdAt) {
      throw new Error('OAuth state details are incomplete.');
    }
    const now = new Date(createdAt).toISOString();
    database.prepare('DELETE FROM auth_oauth_states WHERE expires_at <= ?').run(now);
    database.prepare(`INSERT INTO auth_oauth_states (state_hash, provider, nonce, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(stateHash, provider, nonce, expiresAt, now);
  }

  function consumeOAuthState({ stateHash, provider, now }) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const row = database.prepare(`SELECT state_hash AS stateHash, provider, nonce
        FROM auth_oauth_states WHERE state_hash = ? AND provider = ? AND expires_at > ?`)
        .get(stateHash, provider, now);
      if (!row) {
        database.exec('COMMIT');
        return null;
      }
      database.prepare('DELETE FROM auth_oauth_states WHERE state_hash = ?').run(stateHash);
      database.exec('COMMIT');
      return row;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    createLocal,
    createSessionOnly,
    createOAuthState,
    createOrLinkProvider,
    consumeOAuthState,
    findByEmail,
    findById,
    findByProviderUserId,
    setPasswordHash
  };
}

module.exports = { PROVIDERS, createAuthAccountModel };
