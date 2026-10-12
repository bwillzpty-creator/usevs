const PLAN_CATALOG = {
  'Single-Use': { credits: 1, days: 0 },
  RecruiterPro: { credits: 0, days: 31 },
  EnterpriseVault: { credits: 0, days: 366 }
};
const DAY_MS = 24 * 60 * 60 * 1000;

const normalize = (email) => String(email || '').trim().toLowerCase();

function createEntitlements(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS entitlements (
      email TEXT PRIMARY KEY,
      credits INTEGER NOT NULL DEFAULT 0,
      subscription_expires_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entitlement_sales (
      sale_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      product TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
  `);

  function grant(email, product, saleId) {
    const plan = PLAN_CATALOG[product];
    const key = normalize(email);
    if (!plan || !key) throw new Error('Unknown plan or email.');
    const now = new Date();
    database.exec('BEGIN IMMEDIATE');
    try {
      if (database.prepare('SELECT 1 FROM entitlement_sales WHERE sale_id = ?').get(saleId)) {
        database.exec('COMMIT');
        return false;
      }
      database.prepare('INSERT INTO entitlement_sales (sale_id, email, product, recorded_at) VALUES (?, ?, ?, ?)')
        .run(saleId, key, product, now.toISOString());
      const row = database.prepare('SELECT credits, subscription_expires_at AS expires FROM entitlements WHERE email = ?').get(key);
      let expires = row?.expires || null;
      if (plan.days) {
        const base = expires && new Date(expires) > now ? new Date(expires) : now;
        expires = new Date(base.getTime() + plan.days * DAY_MS).toISOString();
      }
      database.prepare(`INSERT INTO entitlements (email, credits, subscription_expires_at, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET credits = excluded.credits, subscription_expires_at = excluded.subscription_expires_at, updated_at = excluded.updated_at`)
        .run(key, (row?.credits || 0) + plan.credits, expires, now.toISOString());
      database.exec('COMMIT');
      return true;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function revokeSubscription(email) {
    database.prepare('UPDATE entitlements SET subscription_expires_at = NULL, updated_at = ? WHERE email = ?')
      .run(new Date().toISOString(), normalize(email));
  }

  function getStatus(emails) {
    let credits = 0;
    let subscriptionActive = false;
    let everPurchased = false;
    const now = new Date();
    for (const email of [...new Set(emails.map(normalize).filter(Boolean))]) {
      const row = database.prepare('SELECT credits, subscription_expires_at AS expires FROM entitlements WHERE email = ?').get(email);
      if (!row) continue;
      everPurchased = true;
      credits += row.credits;
      if (row.expires && new Date(row.expires) > now) subscriptionActive = true;
    }
    return { credits, subscriptionActive, everPurchased, hasAccess: credits > 0 || subscriptionActive };
  }

  // Subscribers are not charged a credit; otherwise one credit is consumed atomically.
  function consume(emails) {
    if (getStatus(emails).subscriptionActive) return true;
    for (const email of [...new Set(emails.map(normalize).filter(Boolean))]) {
      const result = database.prepare('UPDATE entitlements SET credits = credits - 1, updated_at = ? WHERE email = ? AND credits > 0')
        .run(new Date().toISOString(), email);
      if (result.changes > 0) return email;
    }
    return false;
  }

  function restoreCredit(email) {
    database.prepare('UPDATE entitlements SET credits = credits + 1, updated_at = ? WHERE email = ?')
      .run(new Date().toISOString(), normalize(email));
  }

  return { grant, revokeSubscription, getStatus, consume, restoreCredit };
}

module.exports = { createEntitlements, PLAN_CATALOG };
