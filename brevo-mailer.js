const SENDER_EMAIL = 'No-reply@us-evs.com';
const BREVO_EMAIL_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

function toContacts(value) {
  const recipients = Array.isArray(value) ? value : [value];
  if (!recipients.length) throw new Error('At least one email recipient is required.');
  return recipients.map((recipient) => {
    if (typeof recipient === 'string') return { email: recipient.trim() };
    if (recipient && typeof recipient.email === 'string') {
      return recipient.name ? { email: recipient.email.trim(), name: recipient.name } : { email: recipient.email.trim() };
    }
    throw new Error('Email recipients must be email addresses or contact objects.');
  });
}

function createBrevoMailer({ apiKey = process.env.BREVO_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch API implementation is required for Brevo email delivery.');

  return {
    async sendEmail(message) {
      if (!message || typeof message !== 'object') throw new Error('An email message is required.');
      if (typeof message.subject !== 'string' || !message.subject.trim()) throw new Error('An email subject is required.');

      const body = {
        sender: { name: 'US-EVS', email: SENDER_EMAIL },
        to: toContacts(message.to),
        subject: message.subject,
        ...(typeof message.text === 'string' ? { textContent: message.text } : {}),
        ...(typeof message.html === 'string' ? { htmlContent: message.html } : {})
      };
      if (message.cc) body.cc = toContacts(message.cc);
      if (message.bcc) body.bcc = toContacts(message.bcc);
      if (message.attachments) {
        body.attachment = message.attachments.map((attachment) => {
          if (!attachment || typeof attachment.filename !== 'string' || attachment.content == null) {
            throw new Error('Email attachments require a filename and content.');
          }
          const content = Buffer.isBuffer(attachment.content)
            ? attachment.content
            : Buffer.from(attachment.content);
          return {
            name: attachment.filename,
            content: content.toString('base64'),
            ...(attachment.contentType ? { contentType: attachment.contentType } : {})
          };
        });
      }
      if (!body.textContent && !body.htmlContent) throw new Error('Email text or HTML content is required.');

      const response = await fetchImpl(BREVO_EMAIL_ENDPOINT, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': apiKey.trim(),
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Brevo email delivery failed with HTTP ${response.status}.`);
    }
  };
}

module.exports = { createBrevoMailer, SENDER_EMAIL, BREVO_EMAIL_ENDPOINT };
