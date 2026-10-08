const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fsSync = require('node:fs');
const express = require('express');
const fs = require('fs/promises');
const crypto = require('crypto');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');
const archiver = require('archiver');
const { Document, Footer, ImageRun, Packer, Paragraph, TextRun } = require('docx');
const { createPdfBuffer } = require('./letter-pdf');
const { createVerificationParagraphs } = require('./letter-template');
const { IssuerAuth, SESSION_COOKIE, SESSION_LIFETIME_MS } = require('./issuer-auth');
const { createPaymentLedger, verifyWebhookSignature } = require('./payment-ledger');
const { evaluateStateRules, getReverificationThresholds, parseDmyy, validateDocumentChoice, validateRemoteProcedure } = require('./i9-rules');

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const dataDirectory = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.NODE_ENV === 'production' ? '/var/data/usevs' : __dirname;
const historyPath = path.join(dataDirectory, 'letter_history.json');
const secureLettersPath = path.join(dataDirectory, 'secure_letters.json');
const verificationAuditPath = path.join(dataDirectory, 'verification_audit.json');
const issuerAccountsPath = path.join(dataDirectory, 'issuer_accounts.json');
const documentDatabasePath = path.join(dataDirectory, 'usevs.sqlite');
const smtpPort = Number(process.env.SMTP_PORT || 587);
const emailFrom = process.env.SMTP_FROM || process.env.SMTP_USER;
const emailTransport = process.env.SMTP_HOST && emailFrom && Number.isInteger(smtpPort)
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    })
  : null;
let referenceSequence = 0;
let historyWriteQueue = Promise.resolve();
let letterDataWriteQueue = Promise.resolve();
let database;
let paymentLedger;
const issuerAuth = new IssuerAuth({
  storePath: issuerAccountsPath,
  encryptionKey: process.env.DATA_ENCRYPTION_KEY,
  emailTransport,
  emailFrom,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  reviewToken: process.env.ISSUER_REVIEW_TOKEN,
  businessPostalAddress: process.env.BUSINESS_POSTAL_ADDRESS
});

async function ensureJsonArrayFile(filePath) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await fs.writeFile(filePath, '[]\n', { encoding: 'utf8', flag: 'wx' });
    } catch (createError) {
      if (createError.code !== 'EEXIST') throw createError;
    }
  }
}

function initializeDocumentDatabase() {
  database = new DatabaseSync(documentDatabasePath);
  fsSync.chmodSync(documentDatabasePath, 0o600);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS documents (
      document_id TEXT PRIMARY KEY,
      employer_id TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      encrypted_data TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL UNIQUE REFERENCES documents(document_id) ON DELETE CASCADE,
      employer_id TEXT NOT NULL,
      signatory_id TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      signer_tag TEXT NOT NULL,
      employer_name TEXT NOT NULL,
      employer_email TEXT NOT NULL,
      signatory_name TEXT NOT NULL,
      signatory_title TEXT NOT NULL,
      signatory_email TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      encrypted_contents TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reference_reservations (
      document_id TEXT PRIMARY KEY,
      reserved_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS i9_records (
      record_id TEXT PRIMARY KEY,
      employer_id TEXT NOT NULL,
      encrypted_form_data TEXT NOT NULL,
      work_state TEXT NOT NULL,
      employee_count INTEGER NOT NULL,
      hire_date TEXT NOT NULL,
      authorization_expiration TEXT,
      remote_procedure INTEGER NOT NULL,
      live_video_confirmed INTEGER NOT NULL,
      e_verify_requested INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS i9_attachments (
      attachment_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES i9_records(record_id),
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      encrypted_contents TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS i9_audit_events (
      event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL,
      employer_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS i9_reverification_alerts (
      alert_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES i9_records(record_id),
      employer_id TEXT NOT NULL,
      threshold_days INTEGER NOT NULL CHECK (threshold_days IN (90, 60, 30)),
      due_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE(record_id, threshold_days)
    );
    CREATE TABLE IF NOT EXISTS i9_section3_drafts (
      draft_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES i9_records(record_id),
      employer_id TEXT NOT NULL,
      encrypted_draft TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(record_id)
    );
    CREATE INDEX IF NOT EXISTS documents_by_employer_date ON documents(employer_id, generated_at);
    CREATE INDEX IF NOT EXISTS audit_by_employer_status ON audit_logs(employer_id, status);
    CREATE INDEX IF NOT EXISTS attachments_by_document ON attachments(document_id);
    CREATE INDEX IF NOT EXISTS i9_records_by_employer ON i9_records(employer_id, created_at);
    CREATE INDEX IF NOT EXISTS i9_expiration_by_date ON i9_records(authorization_expiration);
    CREATE TRIGGER IF NOT EXISTS i9_audit_events_no_update
      BEFORE UPDATE ON i9_audit_events BEGIN SELECT RAISE(ABORT, 'i9_audit_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS i9_audit_events_no_delete
      BEFORE DELETE ON i9_audit_events BEGIN SELECT RAISE(ABORT, 'i9_audit_events is append-only'); END;
  `);
}

async function readJsonArray(filePath, label) {
  const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`);
  return value;
}

function appendJsonArray(filePath, label, queueName, entry) {
  const writeEntry = async () => {
    const entries = await readJsonArray(filePath, label);
    entries.push(entry);
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  };
  const pending = letterDataWriteQueue.then(writeEntry, writeEntry);
  letterDataWriteQueue = pending.catch(() => {});
  return pending;
}

function allocateReferenceNumber() {
  const allocate = async () => {
    const audit = await readJsonArray(verificationAuditPath, 'Verification audit');
    const existing = new Set(audit.map((entry) => entry.referenceNumber));
    if (database) {
      database.prepare('SELECT document_id FROM reference_reservations').all().forEach((entry) => existing.add(entry.document_id));
    }
    const year = new Date().getUTCFullYear();
    for (let attempts = 0; attempts < 10000; attempts += 1) {
      referenceSequence = (referenceSequence + 1) % 10000;
      const candidate = `EV-${year}-${String(referenceSequence).padStart(4, '0')}`;
      if (existing.has(candidate)) continue;
      if (!database) return candidate;
      const result = database.prepare('INSERT OR IGNORE INTO reference_reservations (document_id, reserved_at) VALUES (?, ?)').run(candidate, new Date().toISOString());
      if (result.changes === 1) return candidate;
    }
    throw new Error('No verification references are available for this year.');
  };
  const pending = letterDataWriteQueue.then(allocate, allocate);
  letterDataWriteQueue = pending.catch(() => {});
  return pending;
}

function purgeExpiredEmployeeData() {
  const now = Date.now();
  const purge = async () => {
    const secureLetters = await readJsonArray(secureLettersPath, 'Secure letter storage');
    let secureLettersChanged = false;
    secureLetters.forEach((entry) => {
      const expiresAt = Date.parse(entry.expiresAt);
      if (entry.encryptedData && (!Number.isFinite(expiresAt) || expiresAt <= now)) {
        entry.encryptedData = null;
        secureLettersChanged = true;
      }
    });
    if (secureLettersChanged) {
      const temporaryPath = `${secureLettersPath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(secureLetters, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, secureLettersPath);
    }

    const audit = await readJsonArray(verificationAuditPath, 'Verification audit');
    const expiredReferences = new Set(secureLetters.filter((entry) => !entry.encryptedData).map((entry) => entry.referenceNumber));
    let auditChanged = false;
    audit.forEach((entry) => {
      if (entry.status === 'verified' && expiredReferences.has(entry.referenceNumber)) {
        entry.status = 'expired';
        auditChanged = true;
      }
    });
    if (auditChanged) {
      const temporaryPath = `${verificationAuditPath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, verificationAuditPath);
    }
    if (database) {
      const expiredAt = new Date(now).toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare("UPDATE audit_logs SET status = 'expired' WHERE status = 'verified' AND document_id IN (SELECT document_id FROM documents WHERE expires_at <= ? OR encrypted_data IS NULL)").run(expiredAt);
        database.prepare('DELETE FROM attachments WHERE document_id IN (SELECT document_id FROM documents WHERE expires_at <= ?)').run(expiredAt);
        database.prepare("UPDATE documents SET encrypted_data = NULL, status = 'expired' WHERE expires_at <= ? AND encrypted_data IS NOT NULL").run(expiredAt);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };

  const pending = letterDataWriteQueue.then(purge, purge);
  letterDataWriteQueue = pending.catch(() => {});
  return pending;
}

async function migrateLegacyLetterHistory() {
  let history;
  try {
    history = await loadLetterHistory();
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  if (!history.length) return;
  const secureLetters = await readJsonArray(secureLettersPath, 'Secure letter storage');
  const audit = await readJsonArray(verificationAuditPath, 'Verification audit');
  const existingReferences = new Set(secureLetters.map((entry) => entry.referenceNumber));

  for (const entry of history) {
    if (typeof entry.referenceNumber !== 'string' || existingReferences.has(entry.referenceNumber)) continue;
    const generatedAt = getLetterDate(entry) || new Date(0);
    const expiresAt = new Date(generatedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (expiresAt.getTime() > Date.now() && typeof entry.letter === 'string') {
      try {
        secureLetters.push({
          referenceNumber: entry.referenceNumber,
          createdAt: generatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          encryptedData: issuerAuth.encryptRetainedSensitive(JSON.stringify({
            letter: entry.letter,
            employeeName: entry.employeeName || '',
            employerName: entry.employerName || '',
            jobTitle: entry.jobTitle || '',
            startDate: entry.startDate || '',
            endDate: entry.endDate || '',
            companyAddress: entry.companyAddress || ''
          }))
        });
      } catch {
        // Legacy letters without a configured encryption key are scrubbed below.
      }
    }
    audit.push({
      referenceNumber: entry.referenceNumber,
      timestamp: generatedAt.toISOString(),
      status: 'unverified_legacy'
    });
  }

  const secureTemporaryPath = `${secureLettersPath}.tmp`;
  await fs.writeFile(secureTemporaryPath, `${JSON.stringify(secureLetters, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(secureTemporaryPath, secureLettersPath);
  const auditTemporaryPath = `${verificationAuditPath}.tmp`;
  await fs.writeFile(auditTemporaryPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(auditTemporaryPath, verificationAuditPath);
  await fs.writeFile(historyPath, '[]\n', { encoding: 'utf8', mode: 0o600 });
}

async function migrateSecureLettersToDatabase() {
  const [secureLetters, auditLogs] = await Promise.all([
    readJsonArray(secureLettersPath, 'Secure letter storage'),
    readJsonArray(verificationAuditPath, 'Verification audit')
  ]);
  const findAudit = database.prepare('SELECT document_id FROM audit_logs WHERE document_id = ?');
  const insertDocument = database.prepare('INSERT OR IGNORE INTO documents (document_id, employer_id, generated_at, expires_at, encrypted_data, status) VALUES (?, ?, ?, ?, ?, ?)');
  const insertAudit = database.prepare(`INSERT OR IGNORE INTO audit_logs
    (document_id, employer_id, signatory_id, generated_at, ip_address, signer_tag, employer_name, employer_email, signatory_name, signatory_title, signatory_email, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertAttachment = database.prepare('INSERT INTO attachments (document_id, filename, media_type, encrypted_contents) VALUES (?, ?, ?, ?)');
  for (const stored of secureLetters) {
    if (!stored.encryptedData || findAudit.get(stored.referenceNumber)) continue;
    const audit = auditLogs.find((entry) => entry.referenceNumber === stored.referenceNumber && entry.employerId && entry.status !== 'unverified_legacy');
    if (!audit) continue;
    try {
      const data = JSON.parse(issuerAuth.decryptRetainedSensitive(stored.encryptedData));
      const attachmentFiles = Array.isArray(data.attachments) ? data.attachments : [];
      delete data.attachments;
      database.exec('BEGIN IMMEDIATE');
      try {
        insertDocument.run(
          stored.referenceNumber,
          audit.employerId,
          audit.timestamp || stored.createdAt,
          stored.expiresAt,
          JSON.stringify(issuerAuth.encryptRetainedSensitive(JSON.stringify(data))),
          audit.status
        );
        database.prepare('INSERT OR IGNORE INTO reference_reservations (document_id, reserved_at) VALUES (?, ?)')
          .run(stored.referenceNumber, stored.createdAt || audit.timestamp);
        insertAudit.run(
          stored.referenceNumber,
          audit.employerId,
          audit.signatoryId || 'legacy',
          audit.timestamp || stored.createdAt,
          audit.ipAddress || 'unknown',
          audit.signerTag || 'LEGACY',
          audit.employerName || '',
          audit.employerEmail || '',
          audit.signatoryName || '',
          audit.signatoryTitle || '',
          audit.signatoryEmail || '',
          audit.status
        );
        for (const file of attachmentFiles) {
          insertAttachment.run(
            stored.referenceNumber,
            normalizeLetterText(file.name, 120) || 'attachment',
            file.mediaType,
            JSON.stringify(issuerAuth.encryptRetainedSensitive(Buffer.from(file.contents, 'base64').toString('base64')))
          );
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      console.error(`Unable to migrate secure verification record ${stored.referenceNumber} to SQLite:`, error);
    }
  }
}

async function loadLetterHistory() {
  const contents = await fs.readFile(historyPath, 'utf8');
  const history = JSON.parse(contents);
  if (!Array.isArray(history)) {
    throw new Error('Letter history must be a JSON array');
  }
  return history;
}

function getLetterDate(entry) {
  const value = typeof entry.generatedAt === 'string' ? entry.generatedAt : entry.timestamp;
  if (typeof value !== 'string') return null;

  const date = new Date(value.replace(/\s+at\s+/, ' '));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function respondWithAdminHistory(res, routeName, createResponse) {
  try {
    await historyWriteQueue;
    const history = await loadLetterHistory();
    return res.json(createResponse(history));
  } catch (error) {
    console.error(`Unable to read letter history for admin ${routeName}:`, error);
    return res.status(500).json({
      success: false,
      message: 'Unable to read letter history'
    });
  }
}

function appendLetterHistory(entry) {
  const writeEntry = async () => {
    let history;
    try {
      history = await loadLetterHistory();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      history = [];
    }

    history.push(entry);
    const temporaryPath = `${historyPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, historyPath);
  };

  const pendingWrite = historyWriteQueue.then(writeEntry, writeEntry);
  historyWriteQueue = pendingWrite.catch(() => {});
  return pendingWrite;
}

// Allow server to read JSON from POST requests
app.use(cors());
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  return next();
});

app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ success: false, message: 'Payment webhook verification is not configured.' });
  if (!verifyWebhookSignature(req.body, req.get('x-payment-signature'), secret)) {
    return res.status(401).json({ success: false, message: 'Webhook signature is invalid.' });
  }
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
    const result = paymentLedger.appendWebhook({
      providerEventId: event.eventId || event.id,
      paymentId: event.paymentId,
      eventType: event.eventType || event.type,
      payload: event,
      occurredAt: event.occurredAt
    });
    return res.status(200).json({ success: true, duplicate: result.duplicate, payment: result.payment });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof SyntaxError ? 'Webhook body is invalid JSON.' : error.message });
  }
});

app.use(express.json({ limit: '7mb' }));
app.use(express.urlencoded({ extended: false }));

function isSameOriginRequest(req) {
  const origin = req.get('origin');
  if (!origin) return req.get('sec-fetch-site') !== 'cross-site';
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function requireSameOrigin(req, res) {
  if (isSameOriginRequest(req)) return true;
  res.status(403).json({ success: false, message: 'Cross-origin requests are not allowed.' });
  return false;
}

function setIssuerSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}${secure}`);
}

function clearIssuerSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

async function requireIssuerSession(req, res, next) {
  try {
    if (!isSameOriginRequest(req)) return res.status(403).json({ success: false, message: 'Cross-origin requests are not allowed.' });
    req.issuerContext = await issuerAuth.getSession(req);
    if (!req.issuerContext) return res.status(401).json({ success: false, message: 'Verified HR sign-in is required.' });
    res.setHeader('Cache-Control', 'no-store');
    return next();
  } catch (error) {
    console.error('Unable to validate HR session:', error);
    return res.status(500).json({ success: false, message: 'Unable to validate issuer authorization.' });
  }
}

function isValidReviewer(req) {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return issuerAuth.isValidReviewToken(token);
}

function appendI9AuditEvent(recordId, employerId, actorId, eventType, details = {}) {
  database.prepare(`INSERT INTO i9_audit_events
    (record_id, employer_id, actor_id, event_type, details_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(recordId, employerId, actorId, eventType, JSON.stringify(details), new Date().toISOString());
}

function getI9Record(recordId, employerId) {
  const record = database.prepare(`SELECT record_id AS recordId, employer_id AS employerId,
    encrypted_form_data AS encryptedFormData, authorization_expiration AS authorizationExpiration,
    created_at AS createdAt, status FROM i9_records WHERE record_id = ? AND employer_id = ?`)
    .get(recordId, employerId);
  if (!record) return null;
  record.formData = JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(record.encryptedFormData)));
  return record;
}

function createSection3Draft(record) {
  const existing = database.prepare('SELECT draft_id FROM i9_section3_drafts WHERE record_id = ?').get(record.recordId);
  if (existing) return false;
  const draft = {
    title: 'Supplement B (formerly Section 3) Reverification Worksheet Draft',
    notice: 'Not an official USCIS Form I-9. Transfer verified information to the current official Supplement B and complete reverification before expiration.',
    employeeName: record.formData.employeeName,
    hireDate: record.formData.hireDate,
    workState: record.formData.workState,
    authorizationExpiration: record.authorizationExpiration,
    generatedAt: new Date().toISOString(),
    employerAction: 'Examine acceptable, unexpired reverification documentation selected by the employee and complete the current USCIS Supplement B.'
  };
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO i9_section3_drafts (draft_id, record_id, employer_id, encrypted_draft, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), record.recordId, record.employerId,
      JSON.stringify(issuerAuth.encryptRetainedSensitive(JSON.stringify(draft))), now);
  appendI9AuditEvent(record.recordId, record.employerId, 'system', 'section3_draft_created', { authorizationExpiration: record.authorizationExpiration });
  return true;
}

async function processI9ExpirationAlerts() {
  const now = new Date();
  const nowIso = now.toISOString();
  const dueAlerts = database.prepare(`SELECT alert_id AS alertId, record_id AS recordId,
    employer_id AS employerId, threshold_days AS thresholdDays
    FROM i9_reverification_alerts WHERE due_at <= ? AND sent_at IS NULL
    ORDER BY due_at, threshold_days DESC`).all(nowIso);
  if (!dueAlerts.length) return;

  const store = await issuerAuth.readStore();
  for (const alert of dueAlerts) {
    const record = getI9Record(alert.recordId, alert.employerId);
    if (!record) continue;
    if (alert.thresholdDays === 90 || alert.thresholdDays === 60 || alert.thresholdDays === 30) createSection3Draft(record);
    const employer = store.employers.find((entry) => entry.id === alert.employerId && entry.status === 'verified');
    if (!emailTransport || !employer?.businessEmail) continue;
    try {
      await emailTransport.sendMail({
        from: emailFrom,
        to: employer.businessEmail,
        subject: `Work authorization expires within ${alert.thresholdDays} days`,
        text: `Work authorization record ${record.recordId} expires on ${record.authorizationExpiration}. Sign in at ${process.env.PUBLIC_BASE_URL || ''}/i9 and review the employee's Supplement B (formerly Section 3) worksheet. Complete the current USCIS form before the expiration date.${issuerAuth.getEmailFooter()}`
      });
      database.prepare('UPDATE i9_reverification_alerts SET sent_at = ? WHERE alert_id = ? AND sent_at IS NULL').run(nowIso, alert.alertId);
      appendI9AuditEvent(alert.recordId, alert.employerId, 'system', 'reverification_notice_sent', { thresholdDays: alert.thresholdDays });
    } catch (error) {
      console.error('Unable to send I-9 reverification notice:', error);
    }
  }
}

app.get('/i9', async (req, res) => {
  try {
    const session = await issuerAuth.getSession(req);
    if (!session) return res.redirect('/auth');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(__dirname, 'i9.html'));
  } catch (error) {
    console.error('Unable to validate I-9 workspace session:', error);
    return res.status(503).send('Employer sign-in is temporarily unavailable.');
  }
});
app.get('/i9.js', (req, res) => res.sendFile(path.join(__dirname, 'i9.js')));

app.post('/api/i9/rules', requireIssuerSession, (req, res) => {
  try {
    const result = evaluateStateRules(req.body || {});
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/api/i9/records', requireIssuerSession, (req, res) => {
  try {
    const rows = database.prepare(`SELECT record_id AS recordId, encrypted_form_data AS encryptedFormData,
      work_state AS workState, authorization_expiration AS authorizationExpiration, created_at AS createdAt
      FROM i9_records WHERE employer_id = ? ORDER BY created_at DESC`).all(req.issuerContext.employer.id);
    const records = rows.map((row) => {
      const formData = JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(row.encryptedFormData)));
      return {
        recordId: row.recordId,
        employeeName: formData.employeeName,
        workState: row.workState,
        authorizationExpiration: row.authorizationExpiration,
        createdAt: row.createdAt,
        hasSection3Draft: Boolean(database.prepare('SELECT 1 FROM i9_section3_drafts WHERE record_id = ?').get(row.recordId))
      };
    });
    return res.json({ records });
  } catch (error) {
    console.error('Unable to list I-9 records:', error);
    return res.status(500).json({ success: false, message: 'Unable to load I-9 records.' });
  }
});

app.post('/api/i9/records', requireIssuerSession, async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const body = req.body || {};
  const employerId = req.issuerContext.employer.id;
  let hireDate;
  let authorizationExpiration = null;
  try {
    hireDate = parseDmyy(body.hireDate);
    if (body.authorizationExpiration) authorizationExpiration = parseDmyy(body.authorizationExpiration);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (authorizationExpiration && authorizationExpiration < hireDate) {
    return res.status(400).json({ success: false, message: 'Work authorization expiration cannot be earlier than the hire date.' });
  }
  const employeeName = normalizeLetterText(body.employeeName, 160);
  const workState = normalizeLetterText(body.workState, 2).toUpperCase();
  const employeeCount = body.employeeCount;
  const stateLawReviewConfirmed = body.stateLawReviewConfirmed === true;
  let stateRules;
  try {
    stateRules = evaluateStateRules({
      workState,
      employeeCount,
      offerAccepted: body.offerAccepted === true,
      eVerifyRequested: body.eVerifyRequested === true,
      eVerifyEnrolled: body.eVerifyEnrolled === true,
      stateLawReviewConfirmed
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  if (!stateRules.allowed) return res.status(400).json({ success: false, message: stateRules.errors.join(' ') });
  if (!employeeName || body.postersDisplayed !== true) {
    return res.status(400).json({ success: false, message: 'Display both federal posters and provide the employee name before collecting the record.' });
  }
  try {
    validateDocumentChoice({
      listChoice: body.listChoice,
      listAName: normalizeLetterText(body.listAName, 120),
      listBName: normalizeLetterText(body.listBName, 120),
      listCName: normalizeLetterText(body.listCName, 120),
      employeeSelectedDocuments: body.employeeSelectedDocuments === true
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  const remoteProcedure = body.remoteProcedure === true;
  const files = body.authorizationDocuments;
  if (files !== undefined && !Array.isArray(files)) {
    return res.status(400).json({ success: false, message: 'Authorization documents must be uploaded as a list.' });
  }
  if (remoteProcedure && (body.eVerifyEnrolled !== true || body.dhsProcedureEligible !== true || body.liveVideoConfirmed !== true || !files?.length)) {
    return res.status(400).json({ success: false, message: 'The DHS alternative procedure requires E-Verify participation in good standing, retained document copies, a live video examination, and uploaded document copies.' });
  }
  if (body.liveVideoConfirmed === true && remoteProcedure !== true) {
    return res.status(400).json({ success: false, message: 'Confirm the DHS alternative procedure checkbox when recording a remote live-video examination.' });
  }
  const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg'];
  const attachments = [];
  let attachmentBytes = 0;
  try {
    for (const file of files || []) {
      const attachment = decodeUploadedFile(file, allowedTypes, 4000000, 'Authorization document');
      attachmentBytes += Buffer.byteLength(attachment.contents, 'base64');
      if (attachments.length >= 10 || attachmentBytes > 4000000) throw new Error('Upload no more than 10 documents with a combined size below 4 MB.');
      attachments.push(attachment);
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  const recordId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const formData = {
    employeeName,
    workState,
    employeeCount,
    hireDate,
    offerAccepted: body.offerAccepted === true,
    eVerifyEnrolled: body.eVerifyEnrolled === true,
    eVerifyRequested: body.eVerifyRequested === true,
    stateLawReviewConfirmed,
    stateRules,
    remoteProcedure,
    dhsProcedureEligible: body.dhsProcedureEligible === true,
    liveVideoConfirmed: body.liveVideoConfirmed === true,
    postersDisplayed: true,
    listChoice: body.listChoice,
    listAName: normalizeLetterText(body.listAName, 120),
    listBName: normalizeLetterText(body.listBName, 120),
    listCName: normalizeLetterText(body.listCName, 120),
    employeeSelectedDocuments: true,
    authorizationExpiration,
    attachmentNames: attachments.map(({ name, mediaType }) => ({ name, mediaType }))
  };
  let formEnvelope;
  try {
    formEnvelope = JSON.stringify(issuerAuth.encryptRetainedSensitive(JSON.stringify(formData)));
  } catch (error) {
    console.error('I-9 encryption is unavailable:', error);
    return res.status(503).json({ success: false, message: 'Encrypted I-9 storage is unavailable. Configure the employer data encryption key.' });
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO i9_records
      (record_id, employer_id, encrypted_form_data, work_state, employee_count, hire_date,
      authorization_expiration, remote_procedure, live_video_confirmed, e_verify_requested, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .run(recordId, employerId, formEnvelope, workState, employeeCount, hireDate, authorizationExpiration,
        remoteProcedure ? 1 : 0, body.liveVideoConfirmed === true ? 1 : 0, body.eVerifyRequested === true ? 1 : 0, createdAt);
    for (const attachment of attachments) {
      database.prepare(`INSERT INTO i9_attachments
        (attachment_id, record_id, filename, media_type, encrypted_contents) VALUES (?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), recordId, attachment.name, attachment.mediaType,
          JSON.stringify(issuerAuth.encryptRetainedSensitive(attachment.contents)));
    }
    appendI9AuditEvent(recordId, employerId, req.issuerContext.officer.id, 'record_created', {
      workState,
      remoteProcedure,
      liveVideoConfirmed: body.liveVideoConfirmed === true,
      eVerifyRequested: body.eVerifyRequested === true,
      attachmentCount: attachments.length
    });
    if (authorizationExpiration) {
      const expirationTime = Date.parse(`${authorizationExpiration}T00:00:00.000Z`);
      const daysRemaining = Math.ceil((expirationTime - Date.now()) / 86400000);
        const thresholds = getReverificationThresholds(daysRemaining);
      for (const thresholdDays of thresholds) {
        const scheduledTime = expirationTime - thresholdDays * 86400000;
        const dueAt = new Date(Math.max(scheduledTime, Date.now())).toISOString();
        database.prepare(`INSERT INTO i9_reverification_alerts
          (alert_id, record_id, employer_id, threshold_days, due_at, sent_at) VALUES (?, ?, ?, ?, ?, NULL)`)
          .run(crypto.randomUUID(), recordId, employerId, thresholdDays, dueAt);
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    console.error('Unable to save encrypted I-9 record:', error);
    return res.status(503).json({ success: false, message: 'Unable to securely save this I-9 evidence record.' });
  }
  processI9ExpirationAlerts().catch((error) => console.error('I-9 expiration processing failed:', error));
  return res.status(201).json({
    success: true,
    recordId,
    outputNotice: 'Use the downloadable worksheet as an evidence aid; complete the official USCIS Form I-9 separately.'
  });
});

app.get('/api/i9/records/:recordId/export', requireIssuerSession, (req, res) => {
  try {
    const record = getI9Record(req.params.recordId, req.issuerContext.employer.id);
    if (!record) return res.status(404).json({ success: false, message: 'I-9 record not found.' });
    appendI9AuditEvent(record.recordId, record.employerId, req.issuerContext.officer.id, 'worksheet_exported');
    const data = record.formData;
    const lines = [
      'DRAFT I-9 EMPLOYMENT ELIGIBILITY VERIFICATION WORKSHEET',
      'NOT AN OFFICIAL USCIS FORM. Transfer information to the current Form I-9.',
      `Employee: ${data.employeeName}`,
      `First day of employment: ${data.hireDate}`,
      `Work location: ${data.workState}`,
      `Form I-9 document grouping chosen by employee: ${data.listChoice === 'A' ? 'List A' : 'List B plus List C'}`,
      `List A title: ${data.listAName || 'N/A'}`,
      `List B title: ${data.listBName || 'N/A'}`,
      `List C title: ${data.listCName || 'N/A'}`,
      `DHS Alternative Procedure checkbox on official Form I-9: ${data.remoteProcedure ? '[X]' : '[ ]'}`,
      `Remote examination procedure selected: ${data.remoteProcedure ? 'YES' : 'NO'}`,
      `Live video examination confirmed: ${data.liveVideoConfirmed ? 'YES' : 'NO'}`,
      `Supporting copies stored: ${data.attachmentNames.length}`,
      `Work authorization expiration: ${record.authorizationExpiration || 'N/A'}`,
      `E-Verify case requested: ${data.eVerifyRequested ? 'YES' : 'NO'}`,
      `Record ID: ${record.recordId}`,
      `Recorded: ${record.createdAt}`
    ].join('\n');
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="i9-worksheet-${record.recordId}.pdf"`);
    return res.send(createPdfBuffer(lines));
  } catch (error) {
    console.error('Unable to export I-9 worksheet:', error);
    return res.status(500).json({ success: false, message: 'Unable to export this I-9 worksheet.' });
  }
});

app.get('/api/i9/records/:recordId/section3', requireIssuerSession, (req, res) => {
  try {
    const row = database.prepare(`SELECT encrypted_draft AS encryptedDraft FROM i9_section3_drafts
      WHERE record_id = ? AND employer_id = ?`).get(req.params.recordId, req.issuerContext.employer.id);
    if (!row) return res.status(404).json({ success: false, message: 'The automatic Section 3 worksheet is generated at the 90-day notice point.' });
    const draft = JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(row.encryptedDraft)));
    appendI9AuditEvent(req.params.recordId, req.issuerContext.employer.id, req.issuerContext.officer.id, 'section3_draft_exported');
    const lines = [draft.title, draft.notice, `Employee: ${draft.employeeName}`, `Work location: ${draft.workState}`,
      `First day of employment: ${draft.hireDate}`, `Authorization expiration: ${draft.authorizationExpiration}`,
      draft.employerAction, `Draft generated: ${draft.generatedAt}`].join('\n');
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="supplement-b-draft-${req.params.recordId}.pdf"`);
    return res.send(createPdfBuffer(lines));
  } catch (error) {
    console.error('Unable to export Supplement B worksheet:', error);
    return res.status(500).json({ success: false, message: 'Unable to export the Supplement B worksheet.' });
  }
});

app.get('/api/i9/audit-export', requireIssuerSession, (req, res) => {
  const employerId = req.issuerContext.employer.id;
  try {
    appendI9AuditEvent('archive', employerId, req.issuerContext.officer.id, 'audit_archive_exported');
    const recordRows = database.prepare(`SELECT record_id AS recordId, encrypted_form_data AS encryptedFormData,
      work_state AS workState, hire_date AS hireDate, authorization_expiration AS authorizationExpiration,
      remote_procedure AS remoteProcedure, live_video_confirmed AS liveVideoConfirmed, e_verify_requested AS eVerifyRequested,
      created_at AS createdAt, status FROM i9_records WHERE employer_id = ? ORDER BY created_at`).all(employerId);
    const records = recordRows.map((row) => ({
      ...row,
      remoteProcedure: Boolean(row.remoteProcedure),
      liveVideoConfirmed: Boolean(row.liveVideoConfirmed),
      eVerifyRequested: Boolean(row.eVerifyRequested),
      form: JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(row.encryptedFormData)))
    }));
    records.forEach((record) => { delete record.encryptedFormData; });
    const i9Events = database.prepare(`SELECT record_id AS recordId, actor_id AS actorId, event_type AS eventType,
      details_json AS details, recorded_at AS recordedAt FROM i9_audit_events WHERE employer_id = ? ORDER BY event_sequence`).all(employerId);
    const paymentEvents = database.prepare(`SELECT payment_id AS paymentId, event_type AS eventType, source,
      provider_event_id AS providerEventId, payload_json AS payload, occurred_at AS occurredAt,
      recorded_at AS recordedAt FROM payment_events WHERE owner_id = ? ORDER BY event_sequence`).all(employerId);
    const reverificationAlerts = database.prepare(`SELECT alert_id AS alertId, record_id AS recordId,
      threshold_days AS thresholdDays, due_at AS dueAt, sent_at AS sentAt FROM i9_reverification_alerts
      WHERE employer_id = ? ORDER BY due_at, threshold_days DESC`).all(employerId);
    const section3Drafts = database.prepare(`SELECT record_id AS recordId, encrypted_draft AS encryptedDraft,
      created_at AS createdAt FROM i9_section3_drafts WHERE employer_id = ? ORDER BY created_at`).all(employerId)
      .map((draft) => ({
        recordId: draft.recordId,
        draft: JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(draft.encryptedDraft))),
        createdAt: draft.createdAt
      }));
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (error) => {
      console.error('I-9 audit ZIP failed:', error);
      res.destroy(error);
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="ice-audit-${employerId}-${new Date().toISOString().slice(0, 10)}.zip"`);
    archive.pipe(res);
    archive.append(JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2), { name: 'i9-records.json' });
    archive.append(JSON.stringify(i9Events.map((event) => ({ ...event, details: JSON.parse(event.details) })), null, 2), { name: 'i9-audit-events.json' });
    archive.append(JSON.stringify(paymentEvents.map((event) => ({ ...event, payload: JSON.parse(event.payload) })), null, 2), { name: 'payment-events.json' });
    archive.append(JSON.stringify({ alerts: reverificationAlerts, section3Drafts }, null, 2), { name: 'reverification.json' });
    for (const record of recordRows) {
      const attachments = database.prepare(`SELECT filename AS filename, media_type AS mediaType, encrypted_contents AS encryptedContents
        FROM i9_attachments WHERE record_id = ?`).all(record.recordId);
      for (const file of attachments) {
        const contents = issuerAuth.decryptRetainedSensitive(JSON.parse(file.encryptedContents));
        const safeName = file.filename.replace(/[\\/]/g, '_');
        archive.append(Buffer.from(contents, 'base64'), { name: `authorization-documents/${record.recordId}/${safeName}` });
      }
    }
    archive.append('Contains confidential employee data. Handle and retain in accordance with applicable Form I-9 and privacy requirements.\n', { name: 'READ-ME.txt' });
    return archive.finalize();
  } catch (error) {
    console.error('Unable to create I-9 audit archive:', error);
    if (res.headersSent) return res.destroy(error);
    return res.status(500).json({ success: false, message: 'Unable to create the audit archive.' });
  }
});

app.post('/api/payments', requireIssuerSession, (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const amountMinor = req.body?.amountMinor;
  const currency = typeof req.body?.currency === 'string' ? req.body.currency.toUpperCase() : '';
  const reference = normalizeLetterText(req.body?.reference, 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 100000000 || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({ success: false, message: 'Provide a positive amount in minor currency units and a three-letter currency code.' });
  }
  try {
    const result = paymentLedger.initiate(req.get('idempotency-key'), {
      amountMinor,
      currency,
      reference,
      ownerId: req.issuerContext.employer.id
    });
    return res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
  } catch (error) {
    const status = /already used with a different request/.test(error.message) ? 409 : 400;
    return res.status(status).json({ success: false, message: error.message });
  }
});

app.get('/api/payments/:paymentId', requireIssuerSession, (req, res) => {
  const payment = paymentLedger.getPayment(req.params.paymentId, req.issuerContext.employer.id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment was not found.' });
  return res.json({ success: true, ...payment });
});

function renderStateLandingPage(stateName, stateTitle) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${stateTitle} for employers, recruiters, and verification teams in ${stateName}." />
    <title>${stateTitle}</title>
    <link rel="stylesheet" href="/public/brand.css" />
    <style>
      :root { --ink:#1f2937; --green:#176b55; --line:#dfe5e7; --paper:#fff; --canvas:#f3f6f5; }
      * { box-sizing: border-box; }
      body { margin:0; background:var(--canvas); color:var(--ink); font: 16px Arial, sans-serif; }
      main { width:min(760px, calc(100% - 32px)); margin: 64px auto 80px; }
      .card { padding: 32px; background: var(--paper); border: 1px solid var(--line); box-shadow: 0 12px 30px rgba(15,23,42,.08); }
      h1 { margin: 0 0 14px; font-size: clamp(2.1rem, 4vw, 3.2rem); line-height: 1.1; }
      p { color: #4b5d67; line-height: 1.7; }
      .meta { margin-top: 18px; color: var(--green); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 11px; }
      a.button { display:inline-block; margin-top:18px; padding: 12px 18px; background: var(--green); color: #fff; text-decoration:none; border-radius: 4px; font-weight:700; }
      footer { width:min(760px, calc(100% - 32px)); margin: 0 auto 32px; color:#41515b; font-size:12px; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <div class="meta">US-EVS • ${stateName}</div>
        <h1>${stateTitle}</h1>
        <p>Generate compliant, traceable employment verification letters for ${stateName} employers, background screening teams, and verification requestors. Built for fast document preparation, reference lookup, and audit-ready employment histories.</p>
        <p>Use the US-EVS builder to prepare a standardized verification record that can be shared with third parties, lenders, property managers, and HR teams while keeping a verifiable record in the platform.</p>
        <a class="button" href="/">Create a verification letter</a>
      </div>
    </main>
    <footer>us-evs.com is an independent commercial software platform and is not affiliated with any local, state, or federal government agency.</footer>
  </body>
</html>`;
}

app.get('/texas', (req, res) => res.type('html').send(renderStateLandingPage('Texas', 'Texas Standardized Employment Verification Letter Generator')));
app.get('/california', (req, res) => res.type('html').send(renderStateLandingPage('California', 'California Standardized Employment Verification Letter Generator')));
app.get('/florida', (req, res) => res.type('html').send(renderStateLandingPage('Florida', 'Florida Standardized Employment Verification Letter Generator')));
app.get('/new-york', (req, res) => res.type('html').send(renderStateLandingPage('New York', 'New York Standardized Employment Verification Letter Generator')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

app.get('/index.html', async (req, res) => {
  try {
    const context = await issuerAuth.getSession(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!context) return res.redirect('/');
    return res.redirect('/verify');
  } catch (error) {
    console.error('Unable to check issuer session:', error);
    return res.status(503).send('Issuer authentication is unavailable. Please try again later.');
  }
});

app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'issuer.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'issuer.html')));
app.get('/issuer', (req, res) => res.redirect('/auth'));

app.get('/api/auth/session', async (req, res) => {
  try {
    const context = await issuerAuth.getSession(req);
    if (!context) return res.status(401).json({ success: false, message: 'Sign-in required.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, ...context });
  } catch (error) {
    console.error('Unable to load issuer session:', error);
    return res.status(500).json({ success: false, message: 'Unable to load issuer session.' });
  }
});

app.post('/api/employers', async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  try {
    await issuerAuth.registerEmployer(req.body || {}, req.ip);
    return res.status(202).json({
      success: true,
      message: 'Check the corporate business email for a confirmation link. Business review is also required before letter issuance.'
    });
  } catch (error) {
    const unavailable = /requires configured|requires DATA_ENCRYPTION_KEY|Unable to send/.test(error.message);
    return res.status(unavailable ? 503 : 400).json({ success: false, message: error.message });
  }
});

app.get('/api/employers/confirm', async (req, res) => {
  try {
    const confirmed = await issuerAuth.confirmEmployerEmail(req.query.token);
    return res.status(confirmed ? 200 : 400).type('html').send(confirmed
      ? '<!doctype html><title>Email confirmed</title><h1>Corporate email confirmed</h1><p>The employer account is pending business review. Letters cannot be issued until review is complete.</p><a href="/issuer">Return to issuer sign-in</a>'
      : '<!doctype html><title>Confirmation failed</title><h1>Confirmation link is invalid or expired.</h1><a href="/issuer">Return to issuer sign-in</a>');
  } catch (error) {
    console.error('Unable to confirm employer email:', error);
    return res.status(500).send('Unable to confirm the employer email.');
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  try {
    const challenge = await issuerAuth.beginSignIn(req.body?.email, req.body?.password, req.ip);
    return res.json({ success: true, ...challenge, message: 'A one-time code was sent to the signatory corporate email.' });
  } catch (error) {
    const unavailable = /not configured/.test(error.message);
    return res.status(unavailable ? 503 : 401).json({ success: false, message: error.message });
  }
});

app.post('/api/auth/otp', async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  try {
    const result = await issuerAuth.completeSignIn(req.body?.challengeId, req.body?.code);
    setIssuerSessionCookie(res, result.token);
    const redirectTo = result.officer.email === 'review@us-evs.com' ? '/dashboard' : '/verify';
    return res.json({ success: true, employer: result.employer, officer: result.officer, redirectTo });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message });
  }
});

app.post('/api/auth/logout', requireIssuerSession, (req, res) => {
  issuerAuth.logout(req);
  clearIssuerSessionCookie(res);
  return res.json({ success: true });
});

app.post('/api/employers/officers', requireIssuerSession, async (req, res) => {
  try {
    const officer = await issuerAuth.addOfficer(req.issuerContext, req.body || {});
    return res.status(201).json({ success: true, officer, message: 'The signatory can now sign in and verify their corporate email by one-time code.' });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/api/review/employers', async (req, res) => {
  if (!isValidReviewer(req)) return res.status(401).json({ success: false, message: 'Business reviewer authorization required.' });
  try {
    const store = await issuerAuth.readStore();
    return res.json(store.employers.filter((employer) => employer.status === 'pending_review').map((employer) => ({
      id: employer.id,
      legalName: employer.legalName,
      businessEmail: employer.businessEmail,
      domain: employer.domain,
      businessAddress: employer.businessAddress,
      businessPhone: employer.businessPhone,
      signatories: employer.officers.map((officer) => ({
        fullName: officer.fullName,
        title: officer.title,
        email: officer.email
      })),
      createdAt: employer.createdAt,
      hasBusinessDocument: Boolean(employer.businessDocument)
    })));
  } catch (error) {
    console.error('Unable to list employers pending review:', error);
    return res.status(500).json({ success: false, message: 'Unable to load employer review queue.' });
  }
});

app.get('/api/review/employers/:id/document', async (req, res) => {
  if (!isValidReviewer(req)) return res.status(401).json({ success: false, message: 'Business reviewer authorization required.' });
  try {
    const document = await issuerAuth.getBusinessDocument(req.params.id);
    if (!document) return res.status(404).json({ success: false, message: 'No business document is available.' });
    return res.json({ success: true, ...document });
  } catch (error) {
    console.error('Unable to decrypt employer review document:', error);
    return res.status(500).json({ success: false, message: 'Unable to load employer review document.' });
  }
});

app.post('/api/review/employers/:id/approve', async (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  if (!isValidReviewer(req)) return res.status(401).json({ success: false, message: 'Business reviewer authorization required.' });
  try {
    const approved = await issuerAuth.approveEmployer(req.params.id);
    return res.status(approved ? 200 : 409).json({ success: approved, message: approved ? 'Employer approved.' : 'Employer must confirm its email and be pending review.' });
  } catch (error) {
    console.error('Unable to approve employer:', error);
    return res.status(500).json({ success: false, message: 'Unable to approve employer.' });
  }
});

app.use('/api/review', (req, res, next) => {
  if (!isValidReviewer(req)) return res.status(401).json({ success: false, message: 'Business reviewer authorization required.' });
  return next();
});

app.use('/public', express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));
app.get('/issuer.js', (req, res) => res.sendFile(path.join(__dirname, 'issuer.js')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));
app.get('/payment-client.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment-client.js')));
app.get('/letter-pdf.js', (req, res) => res.sendFile(path.join(__dirname, 'letter-pdf.js')));
app.get('/letter-template.js', (req, res) => res.sendFile(path.join(__dirname, 'letter-template.js')));
app.get('/BingSiteAuth.xml', (req, res) => res.sendFile(path.join(__dirname, 'BingSiteAuth.xml')));
app.get('/googlefc80fd584f1dfdf2.html', (req, res) => res.sendFile(path.join(__dirname, 'googlefc80fd584f1dfdf2.html')));
app.get('/robots.txt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'robots.txt')));
app.get('/llms.txt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'llms.txt')));

app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

app.get('/verify', (req, res) => res.sendFile(path.join(__dirname, 'verify.html')));
app.get('/verify-page', (req, res) => res.redirect('/lookup'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/lookup.js', (req, res) => res.sendFile(path.join(__dirname, 'lookup.js')));
app.get('/dashboard.js', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.js')));
app.get('/verify-app.js', (req, res) => res.sendFile(path.join(__dirname, 'verify-app.js')));

app.use(['/history', '/send-email', '/admin'], (req, res) =>
  res.status(404).json({ success: false, message: 'This legacy endpoint is disabled.' })
);

app.get('/lookup', async (req, res) => {
  const referenceNumber = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  if (!referenceNumber) {
    return res.sendFile(path.join(__dirname, 'lookup.html'));
  }

  try {
    const databaseEntry = database.prepare(`SELECT document_id AS referenceNumber, generated_at AS timestamp,
      employer_name AS employerName, employer_email AS employerEmail, signatory_name AS signatoryName,
      signatory_title AS signatoryTitle, signatory_email AS signatoryEmail, status
      FROM audit_logs WHERE document_id = ?`).get(referenceNumber);
    if (databaseEntry) {
      const stored = database.prepare('SELECT encrypted_data AS encryptedData FROM documents WHERE document_id = ?').get(referenceNumber);
      let employeeName = '';
      let purpose = '';
      if (stored?.encryptedData) {
        const privateRecord = JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(stored.encryptedData)));
        employeeName = privateRecord.employeeName || '';
        purpose = privateRecord.purpose || '';
      }
      return res.json({ success: true, ...databaseEntry, employeeName, purpose });
    }
    await letterDataWriteQueue;
    const [audit, secureLetters] = await Promise.all([
      readJsonArray(verificationAuditPath, 'Verification audit'),
      readJsonArray(secureLettersPath, 'Secure letter storage')
    ]);
    const entry = audit.find((item) => item.referenceNumber === referenceNumber);
    if (!entry) {
      return res.status(404).json({
        success: false,
        message: 'Reference not found'
      });
    }
    if (entry.status === 'unverified_legacy') {
      return res.status(404).json({ success: false, message: 'This legacy reference is not verified.' });
    }
    const stored = secureLetters.find((item) => item.referenceNumber === referenceNumber && item.encryptedData && Date.parse(item.expiresAt) > Date.now());
    let employeeName = '';
    let purpose = '';
    if (stored) {
      const privateRecord = JSON.parse(issuerAuth.decryptRetainedSensitive(stored.encryptedData));
      employeeName = privateRecord.employeeName || '';
      purpose = privateRecord.purpose || '';
    }
    return res.json({
      success: true,
      referenceNumber: entry.referenceNumber,
      timestamp: entry.timestamp,
      employerName: entry.employerName,
      employerEmail: entry.employerEmail,
      employeeName,
      purpose,
      signatoryName: entry.signatoryName,
      signatoryTitle: entry.signatoryTitle,
      signatoryEmail: entry.signatoryEmail,
      status: entry.status
    });
  } catch (error) {
    console.error('Unable to read verification audit:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to read verification status'
    });
  }
});

app.post('/send-email', async (req, res) => {
  const recipient = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const referenceNumber = typeof req.body?.referenceNumber === 'string'
    ? req.body.referenceNumber.trim()
    : '';

  if (!recipient || !referenceNumber) {
    return res.status(400).json({
      success: false,
      message: 'Email and referenceNumber are required'
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return res.status(400).json({ success: false, message: 'A valid recipient email is required' });
  }

  let entry;
  try {
    await historyWriteQueue;
    const history = await loadLetterHistory();
    entry = history.find((item) => item.referenceNumber === referenceNumber);
  } catch (error) {
    console.error('Unable to read letter history for email delivery:', error);
    return res.status(500).json({ success: false, message: 'Unable to read letter history' });
  }

  if (!entry) {
    return res.status(404).json({ success: false, message: 'Reference not found' });
  }
  if (!/^[A-Z]{2,5}$/.test(entry.digitalInitials || '')) {
    return res.status(403).json({ success: false, message: 'This record has no page initials and cannot be delivered as a PDF.' });
  }
  if (!emailTransport) {
    return res.status(503).json({ success: false, message: 'Email delivery is not configured' });
  }

  try {
    await emailTransport.sendMail({
      from: emailFrom,
      to: recipient,
      subject: 'Employment Verification Letter',
      text: `Please find the employment verification letter attached.\n\nReference Number: ${entry.referenceNumber}\nGenerated: ${entry.timestamp}${issuerAuth.getEmailFooter()}`,
      attachments: [{
        filename: 'employment_verification_letter.pdf',
        content: createPdfBuffer(entry.letter, undefined, entry.digitalInitials),
        contentType: 'application/pdf'
      }]
    });
    return res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('Unable to send verification email:', error);
    return res.status(502).json({ success: false, message: 'Unable to send email' });
  }
});

app.get('/admin/stats', (req, res) => respondWithAdminHistory(res, 'stats', (history) => {
  const now = new Date();
  const nowTime = now.getTime();
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfLast7Days = nowTime - 7 * 24 * 60 * 60 * 1000;
  let todayCount = 0;
  let last7DaysCount = 0;

  history.forEach((entry) => {
    const generatedAt = getLetterDate(entry);
    if (!generatedAt) return;

    const generatedTime = generatedAt.getTime();
    if (generatedTime >= startOfToday && generatedTime <= nowTime) todayCount += 1;
    if (generatedTime >= startOfLast7Days && generatedTime <= nowTime) last7DaysCount += 1;
  });

  return { totalLetters: history.length, todayCount, last7DaysCount };
}));
 
app.get('/admin-page', (req, res) => res.redirect('/issuer'));

app.get('/admin/recent', (req, res) => respondWithAdminHistory(res, 'recent', (history) =>
  history
    .slice()
    .sort((left, right) => (getLetterDate(right)?.getTime() || 0) - (getLetterDate(left)?.getTime() || 0))
    .slice(0, 10)
));

app.get('/admin/search', (req, res) => respondWithAdminHistory(res, 'search', (history) => {
  const employeeName = typeof req.query.employeeName === 'string' ? req.query.employeeName.trim().toLowerCase() : '';
  const employerName = typeof req.query.employerName === 'string' ? req.query.employerName.trim().toLowerCase() : '';
  const referenceNumber = typeof req.query.referenceNumber === 'string' ? req.query.referenceNumber.trim().toLowerCase() : '';

  return history.filter((entry) =>
    (!employeeName || (typeof entry.employeeName === 'string' && entry.employeeName.toLowerCase().includes(employeeName))) &&
    (!employerName || (typeof entry.employerName === 'string' && entry.employerName.toLowerCase().includes(employerName))) &&
    (!referenceNumber || (typeof entry.referenceNumber === 'string' && entry.referenceNumber.toLowerCase().includes(referenceNumber)))
  );
}));

function normalizeLetterText(value, maximumLength = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximumLength) : '';
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function hasExpectedFileSignature(mediaType, contents) {
  if (mediaType === 'application/pdf') return contents.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mediaType === 'image/png') return contents.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === 'image/jpeg') return contents.length >= 3 && contents[0] === 0xff && contents[1] === 0xd8 && contents[2] === 0xff;
  if (mediaType === 'application/msword') return contents.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return contents.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  return false;
}

function decodeUploadedFile(file, allowedTypes, maximumBytes, label) {
  if (!file || typeof file !== 'object' || typeof file.data !== 'string' || typeof file.type !== 'string') {
    throw new Error(`${label} is not a valid upload.`);
  }
  const match = file.data.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !allowedTypes.includes(match[1])) throw new Error(`${label} has an unsupported file type.`);
  const contents = Buffer.from(match[2], 'base64');
  if (!contents.length || contents.length > maximumBytes ||
      contents.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
    throw new Error(`${label} exceeds the permitted file size or is invalid.`);
  }
  if (!hasExpectedFileSignature(match[1], contents)) throw new Error(`${label} contents do not match the selected file type.`);
  return {
    name: normalizeLetterText(file.name, 120).replace(/[\\/]/g, '_') || label,
    mediaType: match[1],
    contents: contents.toString('base64')
  };
}

function recordForIssuer(referenceNumber, employerId) {
  const auditEntry = database.prepare(`SELECT document_id AS referenceNumber, employer_id AS employerId,
    generated_at AS timestamp, signer_tag AS signerTag, status FROM audit_logs
    WHERE document_id = ? AND employer_id = ? AND status = 'verified'`).get(referenceNumber, employerId);
  if (!auditEntry) return null;
  const stored = database.prepare(`SELECT encrypted_data AS encryptedData, expires_at AS expiresAt
    FROM documents WHERE document_id = ? AND employer_id = ?`).get(referenceNumber, employerId);
  if (!stored || !stored.encryptedData || Date.parse(stored.expiresAt) <= Date.now()) return null;
  const record = JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(stored.encryptedData)));
  record.attachments = database.prepare(`SELECT filename AS name, media_type AS mediaType, encrypted_contents AS encryptedContents
    FROM attachments WHERE document_id = ?`).all(referenceNumber).map((file) => ({
      name: file.name,
      mediaType: file.mediaType,
      contents: issuerAuth.decryptRetainedSensitive(JSON.parse(file.encryptedContents))
    }));
  return { auditEntry, stored, record };
}

function createWordDocument(record, qrBuffer) {
  const paragraphs = record.letter.split(/\r?\n/);
  const content = paragraphs.map((text, index) => new Paragraph({
    children: [new TextRun({
      text,
      bold: index === 0 || text === 'EMPLOYMENT VERIFICATION LETTER' || text.startsWith('Document ID:') || text.startsWith('Authorized representative:'),
      size: text === 'EMPLOYMENT VERIFICATION LETTER' ? 28 : 22,
      font: text.startsWith('Signature:') && record.employeeDetails?.signatureMode === 'type' ? 'Segoe Script' : 'Arial',
      italics: text.startsWith('Signature:') && record.employeeDetails?.signatureMode === 'type'
    })],
    spacing: { after: text ? 180 : 80 }
  }));
  const signature = record.employeeDetails?.signature;
  if (signature?.contents && ['image/png', 'image/jpeg'].includes(signature.mediaType)) {
    content.push(new Paragraph({
      children: [new ImageRun({
        data: Buffer.from(signature.contents, 'base64'),
        transformation: { width: 180, height: 60 }
      })],
      spacing: { before: 120 }
    }));
  }
  if (record.employeeDetails?.logo?.contents && ['image/png', 'image/jpeg'].includes(record.employeeDetails.logo.mediaType)) {
    content.unshift(new Paragraph({
      children: [new ImageRun({
        data: Buffer.from(record.employeeDetails.logo.contents, 'base64'),
        transformation: { width: 120, height: 60 }
      })],
      spacing: { after: 100 }
    }));
  }
  const document = new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      footers: { default: new Footer({ children: [new Paragraph({
        children: [
          new TextRun({ text: `US-EVS · ${record.referenceNumber} · Scan to verify authenticity  `, size: 16 }),
          new ImageRun({ data: qrBuffer, transformation: { width: 60, height: 60 } })
        ]
      })] }) },
      children: content
    }]
  });
  return Packer.toBuffer(document);
}

function buildVerificationUrl(req, referenceNumber, timestamp, signerTag) {
  const url = new URL('/lookup', process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`);
  url.searchParams.set('ref', referenceNumber);
  url.searchParams.set('issued', timestamp);
  url.searchParams.set('tag', signerTag);
  return url.toString();
}

app.get('/api/letters', requireIssuerSession, async (req, res) => {
  const filters = {
    referenceNumber: normalizeLetterText(req.query.referenceNumber, 80).toLowerCase(),
    employeeName: normalizeLetterText(req.query.employeeName, 160).toLowerCase(),
    date: normalizeLetterText(req.query.date, 10),
    purpose: normalizeLetterText(req.query.purpose, 100).toLowerCase()
  };
  try {
    const employerId = req.issuerContext.employer.id;
    const matchingAudit = database.prepare(`SELECT document_id AS referenceNumber, generated_at AS timestamp
      FROM audit_logs WHERE employer_id = ? AND status = 'verified'
      AND (? = '' OR lower(document_id) LIKE '%' || ? || '%')
      AND (? = '' OR substr(generated_at, 1, 10) = ?)
      ORDER BY generated_at DESC`).all(
      employerId,
      filters.referenceNumber,
      filters.referenceNumber,
      filters.date,
      filters.date
    );
    const records = [];
    for (const entry of matchingAudit) {
      const stored = database.prepare('SELECT encrypted_data AS encryptedData, expires_at AS expiresAt FROM documents WHERE document_id = ? AND employer_id = ?').get(entry.referenceNumber, employerId);
      if (!stored || !stored.encryptedData || Date.parse(stored.expiresAt) <= Date.now()) continue;
      const data = JSON.parse(issuerAuth.decryptRetainedSensitive(JSON.parse(stored.encryptedData)));
      if (filters.employeeName && !data.employeeName.toLowerCase().includes(filters.employeeName)) continue;
      if (filters.purpose && (data.purpose || '').toLowerCase() !== filters.purpose) continue;
      records.push({
        referenceNumber: entry.referenceNumber,
        employeeName: data.employeeName,
        timestamp: entry.timestamp,
        purpose: data.purpose,
        status: 'verified',
        letter: data.letter
      });
    }
    return res.json({ records });
  } catch (error) {
    console.error('Unable to load issuer verification records:', error);
    return res.status(500).json({ success: false, message: 'Unable to load verification records.' });
  }
});

app.get('/api/letters/:referenceNumber/export', requireIssuerSession, async (req, res) => {
  const format = typeof req.query.format === 'string' ? req.query.format.toLowerCase() : 'pdf';
  if (!['pdf', 'docx'].includes(format)) return res.status(400).json({ success: false, message: 'Choose PDF or DOCX export.' });
  try {
    const found = recordForIssuer(req.params.referenceNumber, req.issuerContext.employer.id);
    if (!found) return res.status(404).json({ success: false, message: 'Verification record was not found or has expired.' });
    if (format === 'pdf' && !found.record.digitalInitials) {
      return res.status(403).json({ success: false, message: 'This record has no page initials and cannot be exported as a PDF.' });
    }
    const qrContent = buildVerificationUrl(req, req.params.referenceNumber, found.auditEntry.timestamp, found.auditEntry.signerTag);
    const qr = QRCode.create(qrContent, { errorCorrectionLevel: 'M' });
    const qrMatrix = { size: qr.modules.size, data: qr.modules.data };
    const qrBuffer = await QRCode.toBuffer(qrContent, { type: 'png', width: 180, margin: 4 });
    res.setHeader('Cache-Control', 'no-store');
    if (format === 'pdf') {
      res.type('application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="employment-verification-${req.params.referenceNumber}.pdf"`);
      return res.send(createPdfBuffer(found.record.letter, qrMatrix, found.record.digitalInitials));
    }
    const wordDocument = await createWordDocument({ ...found.record, referenceNumber: req.params.referenceNumber }, qrBuffer);
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="employment-verification-${req.params.referenceNumber}.docx"`);
    return res.send(wordDocument);
  } catch (error) {
    console.error('Unable to export verification record:', error);
    return res.status(500).json({ success: false, message: 'Unable to export this verification record.' });
  }
});

app.post('/api/letters/:referenceNumber/email', requireIssuerSession, async (req, res) => {
  const recipientEmail = normalizeLetterText(req.body?.recipientEmail, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return res.status(400).json({ success: false, message: 'A valid recipient email is required.' });
  }
  if (!emailTransport) return res.status(503).json({ success: false, message: 'Email delivery is not configured.' });
  try {
    const found = recordForIssuer(req.params.referenceNumber, req.issuerContext.employer.id);
    if (!found) return res.status(404).json({ success: false, message: 'Verification record was not found or has expired.' });
    if (!found.record.digitalInitials) return res.status(403).json({ success: false, message: 'This record has no page initials and cannot be emailed as a PDF.' });
    const qrContent = buildVerificationUrl(req, req.params.referenceNumber, found.auditEntry.timestamp, found.auditEntry.signerTag);
    const qr = QRCode.create(qrContent, { errorCorrectionLevel: 'M' });
    const qrMatrix = { size: qr.modules.size, data: qr.modules.data };
    const attachments = [{
      filename: `employment-verification-${req.params.referenceNumber}.pdf`,
      content: createPdfBuffer(found.record.letter, qrMatrix, found.record.digitalInitials),
      contentType: 'application/pdf'
    }, ...(found.record.attachments || []).map((file) => ({
      filename: file.name,
      content: Buffer.from(file.contents, 'base64'),
      contentType: file.mediaType
    }))];
    await emailTransport.sendMail({
      from: emailFrom,
      to: recipientEmail,
      cc: req.issuerContext.employer.businessEmail,
      subject: `Employment Verification · ${req.params.referenceNumber}`,
      text: `Please find the employment verification letter and requested attachments.\n\nDocument ID: ${req.params.referenceNumber}\n${issuerAuth.getEmailFooter()}`,
      attachments
    });
    return res.json({ success: true, message: `Verification letter sent to ${recipientEmail}.` });
  } catch (error) {
    console.error('Unable to send verification record:', error);
    return res.status(502).json({ success: false, message: 'Unable to send this verification letter.' });
  }
});

app.post('/verify', (req, res) => res.status(401).json({
  success: false,
  message: 'Public letter generation is disabled. Verified HR sign-in is required.'
}));

app.post('/api/letters', requireIssuerSession, async (req, res) => {
  const body = req.body || {};
  const employee = normalizeLetterText(body.employeeName, 160);
  const position = normalizeLetterText(body.jobTitle, 120);
  const department = normalizeLetterText(body.department, 120);
  const employmentStart = normalizeLetterText(body.startDate, 10);
  const employmentEnd = normalizeLetterText(body.endDate, 10);
  const lifecycle = normalizeLetterText(body.lifecycle, 40);
  const purposeOptions = ['Residential Tenancy', 'Mortgage or Commercial Loan', 'USCIS Immigration', 'Government Background Check', 'Standard Corporate Reference'];
  const statusOptions = ['Full-Time', 'Part-Time', 'Independent Contractor (1099)', 'Temporary'];
  const frequencyOptions = ['Weekly', 'Bi-Weekly', 'Semi-Monthly', 'Monthly', 'Annual'];
  const eligibilityOptions = ['Eligible', 'Not Eligible', 'Conditional'];
  const purpose = normalizeLetterText(body.purpose, 100);
  const workStatus = normalizeLetterText(body.workStatus, 60);
  const payFrequency = normalizeLetterText(body.payFrequency, 30);
  const rehireEligibility = normalizeLetterText(body.rehireEligibility, 40);
  const representativeName = normalizeLetterText(body.representativeName, 160);
  const representativeTitle = normalizeLetterText(body.representativeTitle, 120);
  const representativeEmail = normalizeLetterText(body.representativeEmail, 160).toLowerCase();
  const representativePhone = normalizeLetterText(body.representativePhone, 40);
  const overtimeEligible = normalizeLetterText(body.overtimeEligible, 5);
  const ssnLast4 = normalizeLetterText(body.ssnLast4, 4);
  if (!employee || !position || !department || !validIsoDate(employmentStart) ||
      !['Current Employee', 'Former Employee'].includes(lifecycle) ||
      (lifecycle === 'Former Employee' && (!validIsoDate(employmentEnd) || employmentEnd < employmentStart)) ||
      !purposeOptions.includes(purpose) || !statusOptions.includes(workStatus) ||
      !frequencyOptions.includes(payFrequency) || !eligibilityOptions.includes(rehireEligibility) ||
      !representativeName || !representativeTitle || !representativePhone ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(representativeEmail) ||
      !['Yes', 'No'].includes(overtimeEligible) || (ssnLast4 && !/^\d{4}$/.test(ssnLast4))) {
    return res.status(400).json({ success: false, message: 'Complete required employee, employment, purpose, compensation, and representative fields with valid values.' });
  }
  const { employer, officer } = req.issuerContext;
  if (representativeName.toLowerCase() !== officer.fullName.toLowerCase() ||
      representativeTitle.toLowerCase() !== officer.title.toLowerCase() ||
      representativeEmail !== officer.email.toLowerCase()) {
    return res.status(400).json({ success: false, message: 'The authorized representative must match the verified HR signatory account.' });
  }
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
    return res.status(400).json({ success: false, message: 'Attachments must be uploaded as a list of files.' });
  }
  const attachmentTypes = ['application/pdf', 'image/png', 'image/jpeg', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  const attachments = [];
  let attachmentBytes = 0;
  try {
    for (const file of (body.attachments || [])) {
      const attachment = decodeUploadedFile(file, attachmentTypes, 1500000, 'Attachment');
      attachmentBytes += Buffer.byteLength(attachment.contents, 'base64');
      attachments.push(attachment);
    }
    if (attachments.length > 8 || attachmentBytes > 3500000) {
      return res.status(413).json({ success: false, message: 'Attach no more than 8 files and keep their combined size below 3.5 MB.' });
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  let logo;
  let signature;
  try {
    if (body.logoData) logo = decodeUploadedFile({ name: 'employer-logo', type: '', data: body.logoData }, ['image/png', 'image/jpeg'], 1000000, 'Employer logo');
    if (body.signatureMode === 'upload' && body.signatureData) {
      signature = decodeUploadedFile({ name: 'authorized-signature', type: '', data: body.signatureData }, ['image/png', 'image/jpeg'], 500000, 'Signature');
    } else if (body.signatureMode === 'draw' && body.signatureData) {
      signature = decodeUploadedFile({ name: 'drawn-signature', type: '', data: body.signatureData }, ['image/png'], 500000, 'Signature');
    } else if (body.signatureMode === 'type') {
      signature = { text: normalizeLetterText(body.signatureData, 120) };
    }
    if (!['draw', 'upload', 'type'].includes(body.signatureMode)) throw new Error('Choose a valid signature method.');
    if (body.signatureMode === 'type' && !signature.text) throw new Error('Enter the representative name for the script signature.');
    if (body.signatureMode !== 'type' && !signature) throw new Error('Provide a signature before generating the letter.');
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  const digitalInitials = normalizeLetterText(body.digitalInitials, 5).toUpperCase();
  if (!/^[A-Z]{2,5}$/.test(digitalInitials)) {
    return res.status(400).json({ success: false, message: 'Enter 2 to 5 letters as your digital initials. They will appear on every PDF page.' });
  }
  const hasUploadedContent = attachments.length > 0 || Boolean(logo) || (body.signatureMode === 'upload' && Boolean(signature));
  if (hasUploadedContent && body.contentLiabilityAccepted !== true) {
    return res.status(400).json({ success: false, message: 'Accept the uploaded-content responsibility terms before uploading documents.' });
  }
  const redactSsn = body.redactSsn === true;
  const redactCompensation = body.redactCompensation === true;
  const money = (field, label) => redactCompensation
    ? '[REDACTED]'
    : normalizeLetterText(field, 60) || 'N/A';
  const avgHoursValue = normalizeLetterText(body.averageHours, 6);
  const avgHours = avgHoursValue && Number.isFinite(Number(avgHoursValue)) && Number(avgHoursValue) >= 0 && Number(avgHoursValue) <= 168
    ? avgHoursValue
    : 'N/A';
  const ssnLine = ssnLast4 ? `SSN: ${redactSsn ? '[REDACTED]' : `XXX-XX-${ssnLast4}`}` : 'SSN: N/A';
  const generatedAt = new Date();
  const timestamp = generatedAt.toISOString();
  let referenceNumber;
  try {
    referenceNumber = await allocateReferenceNumber();
  } catch (error) {
    console.error('Unable to allocate a unique verification reference:', error);
    return res.status(503).json({ success: false, message: 'Unable to allocate a verification reference.' });
  }
  const signerTag = `SV-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const basePay = money(body.basePay, 'base pay rate');
  const ytdGross = money(body.ytdGross, 'YTD earnings');
  const bonus = money(body.bonus, 'bonus amount');
  const [paragraphOne, paragraphTwo, paragraphThree] = createVerificationParagraphs({
    employeeName: employee,
    jobTitle: position,
    departmentName: department,
    startDate: employmentStart,
    workStatus,
    lifecycle,
    endDate: employmentEnd,
    rehireEligibility,
    baseSalary: basePay,
    payFrequency,
    averageHours: avgHours,
    ytdEarnings: ytdGross,
    bonusAmount: bonus,
    overtimeEligibility: overtimeEligible,
    verificationPurpose: purpose,
    representativeName: officer.fullName,
    representativePhone,
    representativeEmail: officer.email,
    documentId: referenceNumber
  });
  const disclaimer = body.liabilityDisclaimer === true
    ? 'Information provided reflects company records at the time of issuance and does not constitute a guarantee of future employment or compensation.'
    : '';
  const notaryJurisdiction = normalizeLetterText(body.notaryJurisdiction, 160);
  const commissionExpiration = normalizeLetterText(body.commissionExpiration, 10);
  if (body.notaryBlock === true && (!notaryJurisdiction || !validIsoDate(commissionExpiration))) {
    return res.status(400).json({ success: false, message: 'Enter the notary state/county and a valid commission expiration date.' });
  }
  const notaryText = body.notaryBlock === true
    ? `NOTARY ACKNOWLEDGEMENT\nState / County: ${notaryJurisdiction}\nNotary signature: ______________________________\nCommission expiration: ${commissionExpiration}\n[STATE NOTARY SEAL PLACEHOLDER]`
    : '';
  const displayTimestamp = `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(generatedAt)} UTC`;
  const signatureLine = body.signatureMode === 'type' ? signature.text : '[Digital signature on file]';
  const sealLine = body.corporateSeal === true ? '[DIGITAL CORPORATE SEAL]' : '';
  const verificationUrl = buildVerificationUrl(req, referenceNumber, timestamp, signerTag);
  const letter = [
    employer.legalName.toUpperCase(),
    employer.businessAddress,
    `${employer.businessPhone} · ${employer.businessEmail}`,
    `EIN: ${normalizeLetterText(body.ein, 10) || 'N/A'}`,
    `Prepared for: ${normalizeLetterText(body.recipientName, 160) || 'N/A'}`,
    normalizeLetterText(body.recipientAddress, 240) || 'N/A',
    '',
    'EMPLOYMENT VERIFICATION LETTER',
    `Document ID: ${referenceNumber}`,
    `Generated: ${displayTimestamp}`,
    '',
    paragraphOne,
    ssnLine,
    '',
    paragraphTwo,
    '',
    paragraphThree,
    disclaimer,
    notaryText,
    sealLine,
    '',
    'AUTHORIZED REPRESENTATIVE',
    `Signature: ${signatureLine}`,
    `${officer.fullName}, ${officer.title}`,
    `${representativePhone} · ${officer.email}`,
    `Audit: ${timestamp} · ${signerTag}`,
    `Verification: ${verificationUrl}`
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== '')).join('\n');
  const qrContent = verificationUrl;
  let qrCode;
  try {
    qrCode = await QRCode.toDataURL(qrContent, { errorCorrectionLevel: 'M', margin: 4, width: 180 });
  } catch (error) {
    console.error('Unable to create verification QR code:', error);
    return res.status(503).json({ success: false, message: 'Unable to create the document verification code.' });
  }
  try {
    const documentData = {
      letter,
      digitalInitials,
      employeeName: employee,
      jobTitle: position,
      purpose,
      recipientEmail: normalizeLetterText(body.recipientEmail, 160),
      representativePhone,
      employeeDetails: {
        department,
        lifecycle,
        employmentStart,
        employmentEnd,
        workStatus,
        rehireEligibility,
        payFrequency,
        basePay,
        avgHours,
        ytdGross,
        bonus,
        overtimeEligible,
        ssnLast4: redactSsn ? '' : ssnLast4,
        signatureMode: body.signatureMode,
        signature,
        logo,
        ein: normalizeLetterText(body.ein, 10),
        notaryJurisdiction,
        commissionExpiration
      },
      startDate: employmentStart,
      endDate: employmentEnd
    };
    const expiresAt = new Date(generatedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const encryptedData = JSON.stringify(issuerAuth.encryptRetainedSensitive(JSON.stringify(documentData)));
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`INSERT INTO documents
        (document_id, employer_id, generated_at, expires_at, encrypted_data, status)
        VALUES (?, ?, ?, ?, ?, 'verified')`).run(referenceNumber, employer.id, timestamp, expiresAt, encryptedData);
      database.prepare(`INSERT INTO audit_logs
        (document_id, employer_id, signatory_id, generated_at, ip_address, signer_tag, employer_name, employer_email, signatory_name, signatory_title, signatory_email, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')`).run(
        referenceNumber,
        employer.id,
        officer.id,
        timestamp,
        req.ip || req.socket.remoteAddress || 'unknown',
        signerTag,
        employer.legalName,
        employer.businessEmail,
        officer.fullName,
        officer.title,
        officer.email
      );
      const insertAttachment = database.prepare(`INSERT INTO attachments
        (document_id, filename, media_type, encrypted_contents) VALUES (?, ?, ?, ?)`);
      for (const file of attachments) {
        insertAttachment.run(
          referenceNumber,
          file.name,
          file.mediaType,
          JSON.stringify(issuerAuth.encryptRetainedSensitive(file.contents))
        );
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return res.json({
      success: true,
      letter,
      paragraphs: [paragraphOne, paragraphTwo, paragraphThree],
      ssnLine,
      referenceNumber,
      timestamp,
      signerTag,
      qrCode,
      employerName: employer.legalName,
      employerAddress: employer.businessAddress,
      employerPhone: employer.businessPhone,
      employerEmail: employer.businessEmail
    });
  } catch (error) {
    console.error('Unable to securely save verification letter:', error);
    return res.status(503).json({ success: false, message: 'Secure letter storage is unavailable; no letter was issued.' });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  if (status >= 500) console.error('Unhandled request processing error:', error);
  const message = error.type === 'entity.too.large'
    ? 'The upload exceeds the 7 MB request limit.'
    : status < 500 ? 'The request could not be processed.' : 'An unexpected server error occurred.';
  return res.status(status).json({ success: false, message });
});

// Initialize local ledgers before accepting traffic.
async function startServer() {
  await fs.mkdir(dataDirectory, { recursive: true });
  initializeDocumentDatabase();
  paymentLedger = createPaymentLedger(database);
  await Promise.all([
    ensureJsonArrayFile(historyPath),
    ensureJsonArrayFile(secureLettersPath),
    ensureJsonArrayFile(verificationAuditPath),
    issuerAuth.initialize()
  ]);
  await issuerAuth.ensureReviewAccount('ReviewPassword123!');
  await migrateLegacyLetterHistory();
  await migrateSecureLettersToDatabase();
  await purgeExpiredEmployeeData();
  await processI9ExpirationAlerts();
  const retentionInterval = setInterval(() => {
    purgeExpiredEmployeeData().catch((error) => console.error('Sensitive-data retention purge failed:', error));
  }, 60 * 60 * 1000);
  retentionInterval.unref();
  const i9ExpirationInterval = setInterval(() => {
    processI9ExpirationAlerts().catch((error) => console.error('I-9 expiration processing failed:', error));
  }, 60 * 60 * 1000);
  i9ExpirationInterval.unref();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Unable to initialize application storage:', error);
  process.exitCode = 1;
});
