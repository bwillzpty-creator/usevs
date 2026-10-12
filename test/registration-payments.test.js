const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { IssuerAuth, SESSION_COOKIE } = require('../issuer-auth');
const { createEntitlements } = require('../entitlements');
const { paidSessionDetails, planPriceCents, verifyStripeSignature } = require('../stripe-checkout');

test('simplified registration needs no email delivery and signs the user in', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-register-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new IssuerAuth({ storePath: path.join(directory, 'issuer_accounts.json') });
  await auth.initialize();

  await assert.rejects(auth.registerAccount({ fullName: 'Sam Lee', email: 'bad', organization: 'Acme', password: 'long-test-password-123' }, '1.1.1.1'), /official email/);
  await assert.rejects(auth.registerAccount({ fullName: 'Sam Lee', email: 'sam@acme.example', organization: 'Acme', password: 'short' }, '1.1.1.1'), /Password/);

  const account = await auth.registerAccount({ fullName: 'Sam Lee', email: 'Sam@Acme.example', organization: 'Acme', password: 'long-test-password-123' }, '1.1.1.1');
  await assert.rejects(auth.registerAccount({ fullName: 'Sam Lee', email: 'sam@acme.example', organization: 'Acme', password: 'long-test-password-123' }, '1.1.1.1'), /already exists/);

  const session = await auth.issueSession(account.employerId, account.officerId);
  const context = await auth.getSession({ headers: { cookie: `${SESSION_COOKIE}=${session.token}` } });
  assert.equal(context.officer.email, 'sam@acme.example');
  assert.equal(context.officer.title, 'Authorized Representative');
  assert.deepEqual(await auth.findOfficerByEmail('SAM@acme.example'), account);
});

test('plan purchases set the tier and exact expiry, stacking on active time', () => {
  const database = new DatabaseSync(':memory:');
  const entitlements = createEntitlements(database);
  assert.equal(entitlements.getStatus(['a@x.example']).hasAccess, false);

  const before = Date.now();
  assert.equal(entitlements.grant('a@x.example', '1_week', 'cs_1'), true);
  assert.equal(entitlements.grant('a@x.example', '1_week', 'cs_1'), false);
  let status = entitlements.getStatus(['a@x.example']);
  assert.equal(status.planTier, '1_week');
  assert.equal(status.hasAccess, true);
  const week = new Date(status.expiresAt).getTime() - before;
  assert.ok(Math.abs(week - 7 * 86400000) < 5000);

  entitlements.grant('b@x.example', '1_day', 'cs_2');
  const day = new Date(entitlements.getStatus(['b@x.example']).expiresAt).getTime() - before;
  assert.ok(Math.abs(day - 86400000) < 5000);

  entitlements.grant('c@x.example', '1_month', 'cs_3');
  entitlements.grant('d@x.example', '1_year', 'cs_4');
  const month = new Date(entitlements.getStatus(['c@x.example']).expiresAt);
  const year = new Date(entitlements.getStatus(['d@x.example']).expiresAt);
  assert.ok(month.getTime() - before >= 28 * 86400000 && month.getTime() - before <= 31 * 86400000 + 5000);
  assert.ok(year.getTime() - before >= 365 * 86400000 && year.getTime() - before <= 366 * 86400000 + 5000);

  entitlements.grant('a@x.example', '1_day', 'cs_5');
  status = entitlements.getStatus(['a@x.example']);
  assert.equal(status.planTier, '1_day');
  assert.ok(new Date(status.expiresAt).getTime() - before > 7.9 * 86400000);
});

test('welcome and payment emails use the US-EVS Support sender', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-mail-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const messages = [];
  const auth = new IssuerAuth({
    storePath: path.join(directory, 'issuer_accounts.json'),
    emailTransport: { sendMail: async (message) => messages.push(message) },
    emailFrom: 'no-reply@us-evs.com',
    publicBaseUrl: 'https://us-evs.com'
  });
  await auth.sendWelcomeEmail({ email: 'sam@acme.example', fullName: 'Sam Lee' });
  assert.equal(messages[0].from, '"US-EVS Support" <no-reply@us-evs.com>');
  assert.match(messages[0].text, /sam@acme\.example/);
  assert.match(messages[0].text, /https:\/\/us-evs\.com\/select-plan/);
  await auth.sendPaymentSuccessEmail({ email: 'sam@acme.example', planLabel: '1-Month Access', expiresAt: '2026-11-12T00:00:00.000Z', hasAccount: true });
  assert.match(messages[1].text, /1-Month Access/);
  assert.match(messages[1].text, /\/login/);
});

test('stripe webhook signatures and paid-session checks', () => {
  const secret = 'whsec_test';
  const body = Buffer.from('{"type":"checkout.session.completed"}');
  const now = 1_700_000_000;
  const signature = crypto.createHmac('sha256', secret).update(`${now}.`).update(body).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${signature}`, secret, now), true);
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${signature}`, secret, now + 600), false);
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${'0'.repeat(64)}`, secret, now), false);
  assert.equal(verifyStripeSignature(Buffer.from('tampered'), `t=${now},v1=${signature}`, secret, now), false);

  const session = { id: 'cs_9', payment_status: 'paid', currency: 'usd', amount_total: planPriceCents('1_month'), metadata: { tier: '1_month', account_email: 'a@x.example' } };
  assert.equal(paidSessionDetails(session).tier, '1_month');
  assert.equal(paidSessionDetails({ ...session, amount_total: 1 }), null);
  assert.equal(paidSessionDetails({ ...session, payment_status: 'unpaid' }), null);
  assert.equal(paidSessionDetails({ ...session, metadata: { tier: 'free', account_email: 'a@x.example' } }), null);
});
