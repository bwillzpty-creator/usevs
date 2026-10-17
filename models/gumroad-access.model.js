const crypto = require('node:crypto');

const PLAN_CODES = new Set(['single_use', 'monthly', 'yearly']);
const ACCESS_STATUSES = new Set(['active', 'expired', 'revoked']);

function createGumroadAccessModel(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gumroad_access (
      id TEXT PRIMARY KEY,
      employer_id TEXT NOT NULL,
      gumroad_purchase_id TEXT NOT NULL UNIQUE,
      gumroad_product_id TEXT NOT NULL,
      license_key TEXT NOT NULL,
      plan_code TEXT NOT NULL CHECK (plan_code IN ('single_use', 'monthly', 'yearly')),
      status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gumroad_access_by_employer
      ON gumroad_access(employer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS gumroad_access_by_license
      ON gumroad_access(license_key);
  `);

  const selectFields = `id, employer_id AS employerId, gumroad_purchase_id AS gumroadPurchaseId,
    gumroad_product_id AS gumroadProductId, license_key AS licenseKey, plan_code AS planCode,
    status, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt`;

  function findByEmployerId(employerId) {
    return database.prepare(`SELECT ${selectFields} FROM gumroad_access
      WHERE employer_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(employerId) || null;
  }

  function findActiveByEmployerId(employerId) {
    return database.prepare(`SELECT ${selectFields} FROM gumroad_access
      WHERE employer_id = ? AND status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(employerId) || null;
  }

  function findByPurchaseId(purchaseId) {
    return database.prepare(`SELECT ${selectFields} FROM gumroad_access
      WHERE gumroad_purchase_id = ?`).get(purchaseId) || null;
  }

  function findByLicenseKey(licenseKey) {
    return database.prepare(`SELECT ${selectFields} FROM gumroad_access
      WHERE license_key = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(licenseKey) || null;
  }

  function activate({ employerId, gumroadPurchaseId, gumroadProductId, licenseKey, planCode, expiresAt }) {
    if (!employerId || !gumroadPurchaseId || !gumroadProductId || !licenseKey ||
        !PLAN_CODES.has(planCode) || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('Gumroad access activation details are invalid.');
    }

    const now = new Date().toISOString();
    const existingPurchase = findByPurchaseId(gumroadPurchaseId);
    if (existingPurchase && existingPurchase.employerId !== employerId) {
      throw new Error('This Gumroad purchase is already linked to another employer.');
    }
    const unchanged = existingPurchase && existingPurchase.status === 'active' &&
      existingPurchase.gumroadProductId === gumroadProductId &&
      existingPurchase.licenseKey === licenseKey &&
      existingPurchase.planCode === planCode &&
      existingPurchase.expiresAt === new Date(expiresAt).toISOString();
    if (unchanged) return { access: existingPurchase, changed: false };

    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`UPDATE gumroad_access SET status = 'expired', updated_at = ?
        WHERE employer_id = ? AND status = 'active' AND gumroad_purchase_id <> ?`)
        .run(now, employerId, gumroadPurchaseId);
      if (existingPurchase) {
        database.prepare(`UPDATE gumroad_access SET gumroad_product_id = ?, license_key = ?, plan_code = ?,
          status = 'active', expires_at = ?, updated_at = ? WHERE gumroad_purchase_id = ?`)
          .run(gumroadProductId, licenseKey, planCode, new Date(expiresAt).toISOString(), now, gumroadPurchaseId);
      } else {
        database.prepare(`INSERT INTO gumroad_access
          (id, employer_id, gumroad_purchase_id, gumroad_product_id, license_key, plan_code, status, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
          .run(crypto.randomUUID(), employerId, gumroadPurchaseId, gumroadProductId, licenseKey,
            planCode, new Date(expiresAt).toISOString(), now, now);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { access: findByPurchaseId(gumroadPurchaseId), changed: true };
  }

  function setStatus(employerId, status, purchaseId) {
    if (!ACCESS_STATUSES.has(status)) throw new Error('Unknown Gumroad access status.');
    const now = new Date().toISOString();
    const query = purchaseId
      ? `UPDATE gumroad_access SET status = ?, updated_at = ?
          WHERE employer_id = ? AND gumroad_purchase_id = ? AND status = 'active'`
      : `UPDATE gumroad_access SET status = ?, updated_at = ?
          WHERE employer_id = ? AND status = 'active'`;
    const result = purchaseId
      ? database.prepare(query).run(status, now, employerId, purchaseId)
      : database.prepare(query).run(status, now, employerId);
    return result.changes > 0;
  }

  return { activate, findActiveByEmployerId, findByEmployerId, findByLicenseKey, findByPurchaseId, setStatus };
}

module.exports = { ACCESS_STATUSES, PLAN_CODES, createGumroadAccessModel };
