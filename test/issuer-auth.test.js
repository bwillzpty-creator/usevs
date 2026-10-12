const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { IssuerAuth, SESSION_COOKIE } = require('../issuer-auth');

test('review account is seeded idempotently and still requires email OTP', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-review-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const messages = [];
  const auth = new IssuerAuth({
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailTransport: { sendMail: async (message) => messages.push(message) },
    emailFrom: 'verification@example.test',
    publicBaseUrl: 'https://verification.example.test',
    reviewToken: '',
    businessPostalAddress: '100 Example Avenue, Example City, NY 10001'
  });
  await auth.initialize();

  assert.equal(await auth.ensureReviewAccount('ReviewPassword123!'), true);
  assert.equal(await auth.ensureReviewAccount('ReviewPassword123!'), false);
  const store = await auth.readStore();
  assert.equal(store.employers.length, 1);
  assert.equal(store.employers[0].status, 'verified');
  assert.equal(store.employers[0].officers[0].title, 'Verified User / Full Access');

  const challenge = await auth.beginSignIn('review@us-evs.com', 'ReviewPassword123!', '127.0.0.1');
  const code = messages[0].text.match(/\b(\d{6})\b/)[1];
  const login = await auth.completeSignIn(challenge.challengeId, code);
  const context = await auth.getSession({ headers: { cookie: `${SESSION_COOKIE}=${login.token}` } });
  assert.equal(context.officer.email, 'review@us-evs.com');
});

test('employer review and HR OTP are required for an issuer session', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-issuer-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const messages = [];
  const auth = new IssuerAuth({
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailTransport: { sendMail: async (message) => messages.push(message) },
    emailFrom: 'verification@example.test',
    publicBaseUrl: 'https://verification.example.test',
    reviewToken: 'test-review-token-with-more-than-32-characters',
    businessPostalAddress: '100 Example Avenue, Example City, NY 10001'
  });
  await auth.initialize();

  await assert.rejects(auth.registerEmployer({
    legalBusinessName: 'Northstar Group LLC',
    businessAddress: '18 Market Street',
    businessPhone: '555-0100',
    businessEmail: 'owner@gmail.com',
    officerName: 'Alex Morgan',
    officerTitle: 'HR Director',
    officerEmail: 'hr@yahoo.com',
    officerPassword: 'long-test-password-123'
  }, '127.0.0.1'), /matching corporate emails/);

  await assert.rejects(auth.registerEmployer({
    legalBusinessName: 'Northstar Group LLC',
    businessAddress: '18 Market Street',
    businessPhone: '555-0100',
    businessEmail: 'owner@northstar.example',
    officerName: 'Alex Morgan',
    officerTitle: 'HR Director',
    officerEmail: 'hr@northstar.example',
    officerPassword: 'long-test-password-123'
  }, '127.0.0.1'), /at least 18 years old/);

  const documentContents = Buffer.from('%PDF-1.4\nBusiness registration evidence').toString('base64');
  const registration = await auth.registerEmployer({
    legalBusinessName: 'Northstar Group LLC',
    businessAddress: '18 Market Street',
    businessPhone: '555-0100',
    businessEmail: 'owner@northstar.example',
    officerName: 'Alex Morgan',
    officerTitle: 'HR Director',
    officerEmail: 'hr@northstar.example',
    officerPassword: 'long-test-password-123',
    businessDocument: `data:application/pdf;base64,${documentContents}`,
    ageConfirmed: true,
    contentLiabilityAccepted: true
  }, '127.0.0.1');

  assert.match(messages[0].text, /Physical mailing address: 100 Example Avenue/);
  assert.match(messages[0].text, /subject=Unsubscribe/);
  const confirmationUrl = messages[0].text.match(/https:\/\/\S+/)[0];
  const confirmationToken = new URL(confirmationUrl).searchParams.get('token');
  assert.equal(await auth.confirmEmployerEmail(confirmationToken), true);
  assert.equal(await auth.confirmEmployerEmail(confirmationToken), false);
  const pendingEmployer = (await auth.readStore()).employers[0];
  assert.equal(pendingEmployer.status, 'pending_review');
  assert.notEqual(JSON.stringify(pendingEmployer.businessDocument), documentContents);
  assert.deepEqual(await auth.getBusinessDocument(registration.employerId), {
    mediaType: 'application/pdf',
    contents: documentContents
  });
  await assert.rejects(
    auth.beginSignIn('hr@northstar.example', 'long-test-password-123', '127.0.0.1'),
    /authorization is incomplete/
  );

  assert.equal(await auth.approveEmployer(registration.employerId), true);
  assert.equal((await auth.readStore()).employers[0].businessDocument, null);
  assert.equal(auth.isValidReviewToken('test-review-token-with-more-than-32-characters'), true);
  assert.equal(auth.isValidReviewToken('wrong-token'), false);

  const challenge = await auth.beginSignIn('hr@northstar.example', 'long-test-password-123', '127.0.0.1');
  assert.match(messages[1].text, /Physical mailing address: 100 Example Avenue/);
  assert.match(messages[1].text, /subject=Unsubscribe/);
  const code = messages[1].text.match(/\b(\d{6})\b/)[1];
  const incorrectCode = code === '000000' ? '000001' : '000000';
  await assert.rejects(auth.completeSignIn(challenge.challengeId, incorrectCode), /invalid or expired/);
  const login = await auth.completeSignIn(challenge.challengeId, code);
  const context = await auth.getSession({ headers: { cookie: `${SESSION_COOKIE}=${login.token}` } });
  assert.equal(context.employer.id, registration.employerId);
  assert.equal(context.officer.email, 'hr@northstar.example');

  const encrypted = auth.encryptSensitive('employee data');
  assert.equal(auth.decryptSensitive(encrypted), 'employee data');
  const retained = auth.encryptRetainedSensitive('retained employee data');
  assert.equal(auth.decryptRetainedSensitive(retained), 'retained employee data');
  assert.equal(JSON.stringify(retained).includes('retained employee data'), false);
});

test('consumer email domains register, and support signs in with the static code only without email delivery', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-support-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = {
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailFrom: 'verification@example.test',
    publicBaseUrl: 'https://verification.example.test',
    reviewToken: '',
    businessPostalAddress: '100 Example Avenue, Example City, NY 10001'
  };
  const messages = [];
  const mailed = new IssuerAuth({ ...options, emailTransport: { sendMail: async (message) => messages.push(message) } });
  await mailed.initialize();
  await mailed.registerEmployer({
    legalBusinessName: 'Gmail Co', businessAddress: '1 Main St', businessPhone: '555-0100',
    businessEmail: 'owner@gmail.com', officerName: 'Sam Lee', officerTitle: 'HR',
    officerEmail: 'sam@gmail.com', officerPassword: 'long-test-password-123', ageConfirmed: true
  }, '127.0.0.1');
  assert.equal(messages.length, 1);

  assert.equal(await mailed.ensureSupportAccount('Support2026!'), true);
  await mailed.beginSignIn('support@us-evs.com', 'Support2026!', '127.0.0.2');
  assert.equal(messages.length, 2);

  const unmailed = new IssuerAuth({ ...options, emailTransport: null });
  const challenge = await unmailed.beginSignIn('support@us-evs.com', 'Support2026!', '127.0.0.3');
  const login = await unmailed.completeSignIn(challenge.challengeId, '000000');
  const context = await unmailed.getSession({ headers: { cookie: `${SESSION_COOKIE}=${login.token}` } });
  assert.equal(context.officer.email, 'support@us-evs.com');
});

test('profile updates persist and encrypt the EIN', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-profile-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new IssuerAuth({
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailTransport: null,
    emailFrom: '',
    publicBaseUrl: '',
    reviewToken: '',
    businessPostalAddress: ''
  });
  await auth.initialize();
  await auth.ensureSupportAccount('Support2026!');
  const store = await auth.readStore();
  const context = { employer: { id: store.employers[0].id }, officer: { id: store.employers[0].officers[0].id } };
  const saved = await auth.updateProfile(context, {
    legalName: 'Acme LLC', businessAddress: '1 Main St', taxId: '12-3456789', businessEmail: 'hr@acme.test',
    businessPhone: '202-555-0111', signatoryName: 'Jane Doe', signatoryTitle: 'HR Director'
  });
  assert.equal(saved.taxId, '12-3456789');
  assert.equal((await auth.getProfile(context)).legalName, 'Acme LLC');
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'issuer_accounts.json'), 'utf8'), /12-3456789/);
  await assert.rejects(auth.updateProfile(context, { legalName: 'x' }), /Provide a valid/);
});

test('active sessions roll their expiry forward', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-roll-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new IssuerAuth({
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailTransport: null, emailFrom: '', publicBaseUrl: '', reviewToken: '', businessPostalAddress: ''
  });
  await auth.initialize();
  await auth.ensureSupportAccount('Support2026!');
  const challenge = await auth.beginSignIn('support@us-evs.com', 'Support2026!', '127.0.0.1');
  const { token } = await auth.completeSignIn(challenge.challengeId, '000000');
  const request = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } };
  const [session] = [...auth.sessions.values()];
  session.expiresAt = Date.now() + 60 * 1000;
  assert.ok(await auth.getSession(request));
  assert.ok(session.expiresAt > Date.now() + 11 * 60 * 60 * 1000);
});

test('password change verifies the current password; reset needs an emailed code', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-pw-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const messages = [];
  const auth = new IssuerAuth({
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailTransport: { sendMail: async (message) => messages.push(message) },
    emailFrom: 'verification@example.test',
    publicBaseUrl: 'https://verification.example.test',
    reviewToken: '',
    businessPostalAddress: '100 Example Avenue, Example City, NY 10001'
  });
  await auth.initialize();
  await auth.ensureReviewAccount('ReviewPassword123!');
  const store = await auth.readStore();
  const context = { employer: { id: store.employers[0].id }, officer: { id: store.employers[0].officers[0].id } };

  await assert.rejects(auth.changePassword(context, 'wrong-password-1', 'BrandNewPassword45!'), /Current password is incorrect/);
  await assert.rejects(auth.changePassword(context, 'ReviewPassword123!', 'short'), /between 12 and 128/);
  assert.equal(await auth.changePassword(context, 'ReviewPassword123!', 'BrandNewPassword45!'), true);
  await assert.rejects(auth.beginSignIn('review@us-evs.com', 'ReviewPassword123!', '1.1.1.1'), /Sign-in failed/);
  assert.ok(await auth.beginSignIn('review@us-evs.com', 'BrandNewPassword45!', '1.1.1.1'));

  await auth.requestPasswordReset('nobody@example.test', '1.1.1.1');
  assert.equal(messages.filter((message) => /reset/i.test(message.subject)).length, 0);
  await auth.requestPasswordReset('review@us-evs.com', '1.1.1.1');
  const link = messages.at(-1).text.match(/https:\/\/verification\.example\.test\/reset-password\?token=([\w-]+)/);
  assert.ok(link, 'email carries a reset link');
  const token = link[1];
  assert.equal(auth.isResetTokenValid(token), true);
  await assert.rejects(auth.resetPassword('bogus-token', 'AnotherPassword67!'), /invalid or has expired/);
  await auth.beginSignIn('review@us-evs.com', 'BrandNewPassword45!', '1.1.1.1');
  assert.equal(await auth.resetPassword(token, 'AnotherPassword67!'), true);
  assert.equal(auth.isResetTokenValid(token), false);
  await assert.rejects(auth.resetPassword(token, 'YetAnotherPassword89!'), /invalid or has expired/);
  assert.ok(await auth.beginSignIn('review@us-evs.com', 'AnotherPassword67!', '1.1.1.1'));
});

test('password reset sends nothing and cannot be forced without email delivery', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-pw2-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const auth = new IssuerAuth({
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailTransport: null, emailFrom: '', publicBaseUrl: '', reviewToken: '', businessPostalAddress: ''
  });
  await auth.initialize();
  await auth.ensureSupportAccount('Support2026!');
  await auth.requestPasswordReset('support@us-evs.com', '1.1.1.1');
  await assert.rejects(auth.resetPassword('000000', 'HijackedPassword99!'), /invalid or has expired/);
  assert.ok(await auth.beginSignIn('support@us-evs.com', 'Support2026!', '1.1.1.1'));
});

test('sessions survive a server restart', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usevs-persist-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = {
    storePath: path.join(directory, 'issuer_accounts.json'),
    encryptionKey: Buffer.alloc(32, 7).toString('base64'),
    emailTransport: null, emailFrom: '', publicBaseUrl: '', reviewToken: '', businessPostalAddress: ''
  };
  const first = new IssuerAuth(options);
  await first.initialize();
  await first.ensureSupportAccount('Support2026!');
  const challenge = await first.beginSignIn('support@us-evs.com', 'Support2026!', '127.0.0.1');
  const { token } = await first.completeSignIn(challenge.challengeId, '000000');
  const request = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } };

  const restarted = new IssuerAuth(options);
  await restarted.initialize();
  assert.ok(await restarted.getSession(request));
  restarted.logout(request);
  await restarted.persistSessions();
  const afterLogout = new IssuerAuth(options);
  await afterLogout.initialize();
  assert.equal(await afterLogout.getSession(request), null);
});
