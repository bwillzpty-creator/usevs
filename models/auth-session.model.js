const crypto = require('node:crypto');

function createAuthSessionModel(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
      session_token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_by_account ON auth_sessions(account_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_by_expiry ON auth_sessions(expires_at);
  `);

  function tokenDigest(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  function create({ id, accountId, sessionToken, expiresAt, createdAt }) {
    const tokenHash = tokenDigest(sessionToken);
    database.prepare(`INSERT INTO auth_sessions (id, account_id, session_token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(id, accountId, tokenHash, expiresAt, createdAt);
    return { id, accountId, sessionToken, expiresAt, createdAt };
  }

  function findByToken(sessionToken) {
    if (typeof sessionToken !== 'string' || !sessionToken) return null;
    const tokenHash = tokenDigest(sessionToken);
    return database.prepare(`SELECT id, account_id AS accountId, expires_at AS expiresAt, created_at AS createdAt
      FROM auth_sessions WHERE session_token = ?`).get(tokenHash) || null;
  }

  function refresh(sessionId, expiresAt) {
    database.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(expiresAt, sessionId);
  }

  function destroy(sessionToken) {
    if (typeof sessionToken !== 'string' || !sessionToken) return false;
    return database.prepare('DELETE FROM auth_sessions WHERE session_token = ?')
      .run(tokenDigest(sessionToken)).changes > 0;
  }

  function destroyById(sessionId) {
    return database.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId).changes > 0;
  }

  function deleteExpired(now) {
    return database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now).changes;
  }

  return { create, deleteExpired, destroy, destroyById, findByToken, refresh };
}

module.exports = { createAuthSessionModel };
