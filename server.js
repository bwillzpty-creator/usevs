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
const { Document, Footer, ImageRun, Packer, Paragraph, TextRun } = require('docx');
const { createPdfBuffer } = require('./letter-pdf');
const { createVerificationParagraphs } = require('./letter-template');
const { IssuerAuth, SESSION_COOKIE, SESSION_LIFETIME_MS } = require('./issuer-auth');

const app = express();
const PORT = Number(process.env.PORT) || 8080;
const dataDirectory = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : process.env.NODE_ENV === 'production' ? '/var/data/usevs' : __dirname;
const historyPath = path.join(dataDirectory, 'letter_history.json');
const paymentsPath = path.join(dataDirectory, 'payments.json');
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
let paymentWriteQueue = Promise.resolve();
let letterDataWriteQueue = Promise.resolve();
let database;
const issuerAuth = new IssuerAuth({
  storePath: issuerAccountsPath,
  encryptionKey: process.env.DATA_ENCRYPTION_KEY,
  emailTransport,
  emailFrom,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  reviewToken: process.env.ISSUER_REVIEW_TOKEN
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
    CREATE INDEX IF NOT EXISTS documents_by_employer_date ON documents(employer_id, generated_at);
    CREATE INDEX IF NOT EXISTS audit_by_employer_status ON audit_logs(employer_id, status);
    CREATE INDEX IF NOT EXISTS attachments_by_document ON attachments(document_id);
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

async function loadPayments() {
  const contents = await fs.readFile(paymentsPath, 'utf8');
  const payments = JSON.parse(contents);
  if (!Array.isArray(payments)) {
    throw new Error('Payment history must be a JSON array');
  }
  return payments;
}

async function readPayments() {
  await paymentWriteQueue;
  return loadPayments();
}

function updatePayments(update) {
  const writeUpdate = async () => {
    const payments = await loadPayments();
    const result = update(payments);
    const temporaryPath = `${paymentsPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(payments, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, paymentsPath);
    return result;
  };

  const pendingWrite = paymentWriteQueue.then(writeUpdate, writeUpdate);
  paymentWriteQueue = pendingWrite.catch(() => {});
  return pendingWrite;
}

function encodePayFastValue(value) {
  return encodeURIComponent(String(value).trim())
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

function payFastParameterString(data, includePassphrase = true) {
  const parameters = Object.entries(data)
    .filter(([key, value]) => key !== 'signature' && value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${key}=${encodePayFastValue(value)}`);
  let parameterString = parameters.join('&');

  if (includePassphrase && process.env.PAYFAST_PASSPHRASE) {
    parameterString += `${parameterString ? '&' : ''}passphrase=${encodePayFastValue(process.env.PAYFAST_PASSPHRASE)}`;
  }
  return parameterString;
}

function createPayFastSignature(data) {
  return crypto.createHash('md5').update(payFastParameterString(data)).digest('hex');
}

function isValidPayFastSignature(data) {
  const suppliedSignature = typeof data.signature === 'string' ? data.signature : '';
  if (!/^[a-f0-9]{32}$/i.test(suppliedSignature)) return false;

  const expectedSignature = Buffer.from(createPayFastSignature(data), 'hex');
  const providedSignature = Buffer.from(suppliedSignature, 'hex');
  return crypto.timingSafeEqual(expectedSignature, providedSignature);
}

function payFastBaseUrl() {
  const sandboxSetting = process.env.PAYFAST_SANDBOX;
  const isSandbox = sandboxSetting === undefined
    ? process.env.PAYFAST_MODE !== 'live'
    : sandboxSetting.toLowerCase() === 'true';
  return isSandbox ? 'https://sandbox.payfast.co.za' : 'https://www.payfast.co.za';
}

function addPaymentId(urlValue, paymentId) {
  const url = new URL(urlValue);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PayFast callback URLs must use HTTP or HTTPS');
  url.searchParams.set('m_payment_id', paymentId);
  return url.toString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function paymentStatusPage(title, message, paymentId = '') {
  const paymentReference = paymentId
    ? `<p class="reference">Payment reference: ${escapeHtml(paymentId)}</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#0a192f;color:#f8fafc;font:16px Arial,sans-serif}main{max-width:560px;margin:12vh auto;padding:32px;background:#1e293b;border-top:4px solid #38bdf8;box-shadow:0 8px 24px #00000014}h1{margin-top:0;font-size:24px}.reference{color:#cbd5e1;font-size:13px}a{display:inline-block;margin-top:12px;color:#38bdf8}</style><link rel="stylesheet" href="/public/brand.css"></head>
<body><main class="payment-status-card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${paymentReference}<a href="/">Return to Employment Verification</a></main></body></html>`;
}

// Allow server to read JSON from POST requests
app.use(cors());
app.set('trust proxy', 1);
app.use(express.json({ limit: '7mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  return next();
});

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
    return res.json({ success: true, employer: result.employer, officer: result.officer });
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
app.get('/letter-pdf.js', (req, res) => res.sendFile(path.join(__dirname, 'letter-pdf.js')));
app.get('/letter-template.js', (req, res) => res.sendFile(path.join(__dirname, 'letter-template.js')));
app.get('/BingSiteAuth.xml', (req, res) => res.sendFile(path.join(__dirname, 'BingSiteAuth.xml')));
app.get('/googlefc80fd584f1dfdf2.html', (req, res) => res.sendFile(path.join(__dirname, 'googlefc80fd584f1dfdf2.html')));

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
  if (!emailTransport) {
    return res.status(503).json({ success: false, message: 'Email delivery is not configured' });
  }

  try {
    await emailTransport.sendMail({
      from: emailFrom,
      to: recipient,
      subject: 'Employment Verification Letter',
      text: `Please find the employment verification letter attached.\n\nReference Number: ${entry.referenceNumber}\nGenerated: ${entry.timestamp}`,
      attachments: [{
        filename: 'employment_verification_letter.pdf',
        content: createPdfBuffer(entry.letter),
        contentType: 'application/pdf'
      }]
    });
    return res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('Unable to send verification email:', error);
    return res.status(502).json({ success: false, message: 'Unable to send email' });
  }
});

app.post('/payfast/initiate', async (req, res) => {
  const paymentType = req.body?.paymentType || req.body?.type;
  if (!['once-off', 'subscription'].includes(paymentType)) {
    return res.status(400).json({ success: false, message: 'Payment type must be once-off or subscription' });
  }

  const amountSetting = paymentType === 'subscription'
    ? 'PAYFAST_SUBSCRIPTION_AMOUNT'
    : 'PAYFAST_ONCE_OFF_AMOUNT';
  const amount = Number(process.env[amountSetting]);
  const requiredSettings = [
    'PAYFAST_MERCHANT_ID',
    'PAYFAST_MERCHANT_KEY',
    'PAYFAST_RETURN_URL',
    'PAYFAST_CANCEL_URL',
    'PAYFAST_NOTIFY_URL'
  ];
  const missingSettings = requiredSettings.filter((name) => !process.env[name]);
  if (!Number.isFinite(amount) || amount < 4.99) missingSettings.push(amountSetting);
  if (paymentType === 'subscription' && !process.env.PAYFAST_PASSPHRASE) {
    missingSettings.push('PAYFAST_PASSPHRASE');
  }
  if (missingSettings.length) {
    return res.status(503).json({
      success: false,
      message: `PayFast configuration is incomplete: ${[...new Set(missingSettings)].join(', ')}`
    });
  }

  const sandboxSetting = process.env.PAYFAST_SANDBOX;
  if (sandboxSetting !== undefined && !['true', 'false'].includes(sandboxSetting.toLowerCase())) {
    return res.status(503).json({ success: false, message: 'PAYFAST_SANDBOX must be true or false' });
  }
  const mode = process.env.PAYFAST_MODE || 'sandbox';
  if (!['sandbox', 'live'].includes(mode)) {
    return res.status(503).json({ success: false, message: 'PAYFAST_MODE must be sandbox or live' });
  }

  const recipient = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required' });
  }

  const frequency = Number(process.env.PAYFAST_SUBSCRIPTION_FREQUENCY || 3);
  const cycles = Number(process.env.PAYFAST_SUBSCRIPTION_CYCLES ?? 0);
  if (paymentType === 'subscription' &&
      (!Number.isInteger(frequency) || frequency < 1 || frequency > 6 || !Number.isInteger(cycles) || cycles < 0)) {
    return res.status(503).json({ success: false, message: 'PayFast subscription settings are invalid' });
  }

  const paymentId = crypto.randomUUID();
  const itemName = paymentType === 'subscription'
    ? 'Employment Verification Premium Subscription'
    : 'Employment Verification Premium';
  let returnUrl;
  let cancelUrl;
  try {
    returnUrl = addPaymentId(process.env.PAYFAST_RETURN_URL, paymentId);
    cancelUrl = addPaymentId(process.env.PAYFAST_CANCEL_URL, paymentId);
  } catch (error) {
    return res.status(503).json({ success: false, message: 'PayFast callback URLs are invalid' });
  }

  const paymentFields = {
    merchant_id: process.env.PAYFAST_MERCHANT_ID,
    merchant_key: process.env.PAYFAST_MERCHANT_KEY,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    notify_url: process.env.PAYFAST_NOTIFY_URL,
    email_address: recipient,
    m_payment_id: paymentId,
    amount: amount.toFixed(2),
    item_name: itemName
  };
  if (paymentType === 'subscription') {
    paymentFields.subscription_type = '1';
    paymentFields.recurring_amount = amount.toFixed(2);
    paymentFields.frequency = String(frequency);
    paymentFields.cycles = String(cycles);
  }
  paymentFields.signature = createPayFastSignature(paymentFields);

  try {
    await updatePayments((payments) => {
      payments.push({
        m_payment_id: paymentId,
        payment_type: paymentType,
        amount: amount.toFixed(2),
        item_name: itemName,
        email_address: recipient || '',
        status: 'PENDING',
        premium: false,
        created_at: new Date().toISOString()
      });
    });
  } catch (error) {
    console.error('Unable to record pending PayFast payment:', error);
    return res.status(500).json({ success: false, message: 'Unable to initialize payment' });
  }

  const fieldsHtml = Object.entries(paymentFields)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');
  const checkoutUrl = `${payFastBaseUrl()}/eng/process`;
  return res.status(200).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Redirecting to PayFast</title></head>
<body><main><h1>Redirecting to PayFast</h1><p>Your payment is being prepared securely.</p>
<form id="payfastCheckout" action="${escapeHtml(checkoutUrl)}" method="post">${fieldsHtml}<button type="submit">Continue to PayFast</button></form>
<script>document.getElementById('payfastCheckout').submit();</script></main></body></html>`);
});

app.post('/payfast/notify', async (req, res) => {
  const notification = req.body;
  if (!notification || typeof notification !== 'object' ||
      Object.values(notification).some((value) => typeof value !== 'string')) {
    return res.status(400).json({ success: false, message: 'Invalid PayFast notification data' });
  }
  if (!process.env.PAYFAST_MERCHANT_ID || !isValidPayFastSignature(notification)) {
    return res.status(400).json({ success: false, message: 'Invalid PayFast signature' });
  }
  if (notification.merchant_id !== process.env.PAYFAST_MERCHANT_ID) {
    return res.status(400).json({ success: false, message: 'PayFast merchant ID mismatch' });
  }
  if (!notification.m_payment_id || !['COMPLETE', 'CANCELLED'].includes(notification.payment_status)) {
    return res.status(400).json({ success: false, message: 'Invalid PayFast payment data' });
  }

  let payment;
  try {
    const payments = await readPayments();
    payment = payments.find((entry) => entry.m_payment_id === notification.m_payment_id);
  } catch (error) {
    console.error('Unable to read payments for PayFast notification:', error);
    return res.status(500).json({ success: false, message: 'Unable to read payment records' });
  }
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment reference not found' });
  }
  if (notification.payment_status === 'COMPLETE') {
    const actualAmount = Number(notification.amount_gross);
    if (!Number.isFinite(actualAmount) || Math.abs(actualAmount - Number(payment.amount)) > 0.01) {
      return res.status(400).json({ success: false, message: 'PayFast amount mismatch' });
    }
    if (payment.status === 'COMPLETE' && payment.premium === true) return res.status(200).send('OK');
  }

  let confirmationResponse;
  try {
    confirmationResponse = await fetch(`${payFastBaseUrl()}/eng/query/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payFastParameterString(notification, false),
      signal: AbortSignal.timeout(10000)
    });
    if (!confirmationResponse.ok || (await confirmationResponse.text()).trim() !== 'VALID') {
      return res.status(400).json({ success: false, message: 'PayFast could not confirm the notification' });
    }
  } catch (error) {
    console.error('PayFast notification confirmation failed:', error);
    return res.status(502).json({ success: false, message: 'Unable to confirm payment with PayFast' });
  }

  try {
    await updatePayments((payments) => {
      const record = payments.find((entry) => entry.m_payment_id === notification.m_payment_id);
      if (!record) throw new Error('Payment reference not found during update');
      if (notification.payment_status === 'COMPLETE') {
        Object.assign(record, {
          status: 'COMPLETE',
          premium: true,
          premium_features: record.payment_type === 'subscription'
            ? ['unlimited_letters', 'email_delivery']
            : ['one_letter', 'email_delivery'],
          pf_payment_id: notification.pf_payment_id || '',
          amount_gross: notification.amount_gross,
          email_address: notification.email_address || record.email_address,
          paid_at: new Date().toISOString()
        });
      } else if (record.status !== 'COMPLETE') {
        Object.assign(record, { status: 'CANCELLED', premium: false });
      }
    });
  } catch (error) {
    console.error('Unable to save PayFast notification:', error);
    return res.status(500).json({ success: false, message: 'Unable to save payment confirmation' });
  }

  return res.status(200).send('OK');
});

app.get('/payfast/return', async (req, res) => {
  const paymentId = typeof req.query.m_payment_id === 'string' ? req.query.m_payment_id : '';
  if (!paymentId) {
    return res.status(400).type('html').send(paymentStatusPage('Payment confirmation pending', 'We could not identify this payment.'));
  }

  try {
    const payments = await readPayments();
    const payment = payments.find((entry) => entry.m_payment_id === paymentId);
    if (payment?.status === 'COMPLETE' && payment.premium === true) {
      return res.type('html').send(paymentStatusPage(
        'Payment Successful',
        'Premium access is active for this payment.',
        payment.m_payment_id
      ));
    }
    return res.status(202).type('html').send(paymentStatusPage(
      'Payment confirmation pending',
      'Premium access will be enabled after PayFast confirms the payment.',
      paymentId
    ));
  } catch (error) {
    console.error('Unable to read payment for PayFast return:', error);
    return res.status(500).type('html').send(paymentStatusPage(
      'Payment status unavailable',
      'We could not check your payment status. Please try again shortly.',
      paymentId
    ));
  }
});

app.get('/payfast/cancel', (req, res) => res.type('html').send(paymentStatusPage(
  'Payment Cancelled',
  'The payment was cancelled. No premium access was activated.'
)));

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
    const qrContent = buildVerificationUrl(req, req.params.referenceNumber, found.auditEntry.timestamp, found.auditEntry.signerTag);
    const qr = QRCode.create(qrContent, { errorCorrectionLevel: 'M' });
    const qrMatrix = { size: qr.modules.size, data: qr.modules.data };
    const qrBuffer = await QRCode.toBuffer(qrContent, { type: 'png', width: 180, margin: 4 });
    res.setHeader('Cache-Control', 'no-store');
    if (format === 'pdf') {
      res.type('application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="employment-verification-${req.params.referenceNumber}.pdf"`);
      return res.send(createPdfBuffer(found.record.letter, qrMatrix));
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
    const qrContent = buildVerificationUrl(req, req.params.referenceNumber, found.auditEntry.timestamp, found.auditEntry.signerTag);
    const qr = QRCode.create(qrContent, { errorCorrectionLevel: 'M' });
    const qrMatrix = { size: qr.modules.size, data: qr.modules.data };
    const attachments = [{
      filename: `employment-verification-${req.params.referenceNumber}.pdf`,
      content: createPdfBuffer(found.record.letter, qrMatrix),
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
      text: `Please find the employment verification letter and requested attachments.\n\nDocument ID: ${req.params.referenceNumber}\n`,
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
  const redactSsn = body.redactSsn === true;
  const redactCompensation = body.redactCompensation === true;
  const money = (field, label) => redactCompensation
    ? '[REDACTED]'
    : normalizeLetterText(field, 60) || `not provided (${label})`;
  const avgHoursValue = normalizeLetterText(body.averageHours, 6);
  const avgHours = avgHoursValue && Number.isFinite(Number(avgHoursValue)) && Number(avgHoursValue) >= 0 && Number(avgHoursValue) <= 168
    ? avgHoursValue
    : 'not provided';
  const ssnLine = ssnLast4 ? `SSN: ${redactSsn ? '[REDACTED]' : `XXX-XX-${ssnLast4}`}` : '';
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
    normalizeLetterText(body.ein, 10) ? `EIN: ${normalizeLetterText(body.ein, 10)}` : '',
    normalizeLetterText(body.recipientName, 160) ? `Prepared for: ${normalizeLetterText(body.recipientName, 160)}` : '',
    normalizeLetterText(body.recipientAddress, 240),
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
  await Promise.all([
    ensureJsonArrayFile(historyPath),
    ensureJsonArrayFile(paymentsPath),
    ensureJsonArrayFile(secureLettersPath),
    ensureJsonArrayFile(verificationAuditPath),
    issuerAuth.initialize()
  ]);
  await migrateLegacyLetterHistory();
  await migrateSecureLettersToDatabase();
  await purgeExpiredEmployeeData();
  const retentionInterval = setInterval(() => {
    purgeExpiredEmployeeData().catch((error) => console.error('Sensitive-data retention purge failed:', error));
  }, 60 * 60 * 1000);
  retentionInterval.unref();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Unable to initialize application storage:', error);
  process.exitCode = 1;
});
