const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const fs = require('fs/promises');
const crypto = require('crypto');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { createPdfBuffer } = require('./letter-pdf');

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const historyPath = path.join(dataDirectory, 'letter_history.json');
const paymentsPath = path.join(dataDirectory, 'payments.json');
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
<style>body{margin:0;background:#f3f6f5;color:#1f2937;font:16px Arial,sans-serif}main{max-width:560px;margin:12vh auto;padding:32px;background:#fff;border-top:4px solid #176b55;box-shadow:0 8px 24px #00000014}h1{margin-top:0;font-size:24px}.reference{color:#52616b;font-size:13px}a{display:inline-block;margin-top:12px;color:#105541}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${paymentReference}<a href="/">Return to Employment Verification</a></main></body></html>`;
}

// Allow server to read JSON from POST requests
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

app.get('/verify-page', (req, res) => {
  res.sendFile(path.join(__dirname, 'verify.html'));
});

app.get('/history', async (req, res) => {
  try {
    await historyWriteQueue;
    return res.json(await loadLetterHistory());
  } catch (error) {
    console.error('Unable to read letter history:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to read letter history'
    });
  }
});

app.get('/lookup', async (req, res) => {
  const referenceNumber = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  if (!referenceNumber) {
    return res.status(404).json({
      success: false,
      message: 'Reference not found'
    });
  }

  try {
    await historyWriteQueue;
    const history = await loadLetterHistory();
    const entry = history.find((item) => item.referenceNumber === referenceNumber);
    if (!entry) {
      return res.status(404).json({
        success: false,
        message: 'Reference not found'
      });
    }
    return res.json(entry);
  } catch (error) {
    console.error('Unable to read letter history for lookup:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to read letter history'
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
  if (!Number.isFinite(amount) || amount < 5) missingSettings.push(amountSetting);
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
 
 app.get('/admin-page', (req, res) => {
   res.sendFile(path.join(__dirname, 'admin.html'));
 });

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

// Employment Verification Route
app.post('/verify', async (req, res) => {
  const {
    employeeName,
    employerName,
    jobTitle,
    startDate,
    endDate,
    companyAddress
  } = req.body || {};

  const normalizeText = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const employee = normalizeText(employeeName);
  const employer = normalizeText(employerName);
  const position = normalizeText(jobTitle);
  const employmentStart = normalizeText(startDate);
  const employmentEnd = normalizeText(endDate);
  const address = normalizeText(companyAddress) || 'Not provided';

  if (!employee || !employer || !position || !employmentStart) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields"
    });
  }

  const generatedAt = new Date();
  referenceSequence += 1;
  const referenceNumber = `EV-${generatedAt.getUTCFullYear()}-${String(referenceSequence).padStart(4, '0')}`;
  const timestamp = `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(generatedAt)} UTC`;

  const letter = `EMPLOYMENT VERIFICATION LETTER
Reference Number: ${referenceNumber}
Generated: ${timestamp}

Employee Information
  Employee Name: ${employee}

Employment Details
  Employer: ${employer}
  Position: ${position}
  Employment Period: ${employmentStart} - ${employmentEnd || 'Not provided'}

Company Information
  Company Address: ${address}

Closing Statement
  This letter confirms the employment information stated above.
  Please contact our office if further verification is required.
`;

  try {
    await appendLetterHistory({
      referenceNumber,
      timestamp,
      employeeName: employee,
      employerName: employer,
      jobTitle: position,
      startDate: employmentStart,
      endDate: employmentEnd,
      companyAddress: address,
      letter
    });
  } catch (error) {
    console.error('Unable to save letter history:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to save verification letter history'
    });
  }

  res.json({
    success: true,
    letter,
    referenceNumber,
    timestamp
  });
});

// Initialize local ledgers before accepting traffic.
async function startServer() {
  await fs.mkdir(dataDirectory, { recursive: true });
  await Promise.all([
    ensureJsonArrayFile(historyPath),
    ensureJsonArrayFile(paymentsPath)
  ]);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Unable to initialize application storage:', error);
  process.exitCode = 1;
});
