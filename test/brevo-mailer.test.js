const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrevoMailer, BREVO_EMAIL_ENDPOINT, SENDER_EMAIL } = require('../brevo-mailer');

test('Brevo sends mail from the fixed US-EVS sender with copies and attachments', async () => {
  let request;
  const mailer = createBrevoMailer({
    apiKey: 'test-api-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 201 };
    }
  });

  await mailer.sendEmail({
    from: 'untrusted@example.com',
    to: 'hr@example.com',
    cc: 'audit@example.com',
    subject: 'Verification code',
    text: 'Your code is 123456.',
    html: '<p>Your code is <strong>123456</strong>.</p>',
    attachments: [{
      filename: 'letter.pdf',
      content: Buffer.from('%PDF-test'),
      contentType: 'application/pdf'
    }]
  });

  assert.equal(request.url, BREVO_EMAIL_ENDPOINT);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['api-key'], 'test-api-key');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.sender, { name: 'US-EVS', email: SENDER_EMAIL });
  assert.equal(body.sender.email, 'No-reply@us-evs.com');
  assert.deepEqual(body.to, [{ email: 'hr@example.com' }]);
  assert.deepEqual(body.cc, [{ email: 'audit@example.com' }]);
  assert.equal(body.textContent, 'Your code is 123456.');
  assert.equal(body.htmlContent, '<p>Your code is <strong>123456</strong>.</p>');
  assert.deepEqual(body.attachment, [{
    name: 'letter.pdf',
    content: Buffer.from('%PDF-test').toString('base64'),
    contentType: 'application/pdf'
  }]);
});

test('Brevo mailer is unavailable without an API key and reports API errors', async () => {
  assert.equal(createBrevoMailer({ apiKey: '' }), null);
  const mailer = createBrevoMailer({
    apiKey: 'test-api-key',
    fetchImpl: async () => ({ ok: false, status: 401 })
  });

  await assert.rejects(
    mailer.sendEmail({ to: 'hr@example.com', subject: 'Code', text: '123456' }),
    /Brevo email delivery failed with HTTP 401/
  );
});

test('Brevo mailer reads its API key from the environment by default', async () => {
  const previousKey = process.env.BREVO_API_KEY;
  process.env.BREVO_API_KEY = 'environment-api-key';
  try {
    let headers;
    const mailer = createBrevoMailer({
      fetchImpl: async (_url, options) => {
        headers = options.headers;
        return { ok: true, status: 201 };
      }
    });
    await mailer.sendEmail({ to: 'hr@example.com', subject: 'Code', text: '123456' });
    assert.equal(headers['api-key'], 'environment-api-key');
  } finally {
    if (previousKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = previousKey;
  }
});
