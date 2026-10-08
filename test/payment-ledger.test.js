const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { createPaymentLedger, derivePaymentStatus, verifyWebhookSignature } = require('../payment-ledger');

function withLedger(callback) {
  const database = new DatabaseSync(':memory:');
  const ledger = createPaymentLedger(database);
  try {
    callback(database, ledger);
  } finally {
    database.close();
  }
}

test('idempotency retries return the same payment and reject changed requests', () => {
  withLedger((database, ledger) => {
    const key = crypto.randomUUID();
    const request = { amount: 1200, currency: 'USD', ownerId: 'employer-1' };
    const first = ledger.initiate(key, request);
    const replay = ledger.initiate(key, request);
    assert.equal(replay.paymentId, first.paymentId);
    assert.equal(replay.replayed, true);
    assert.equal(database.prepare('SELECT count(*) AS count FROM payment_events').get().count, 1);
    assert.throws(() => ledger.initiate(key, { ...request, amount: 1300 }), /different request/);
  });
});

test('webhook event IDs deduplicate and status is derived from the timeline', () => {
  withLedger((database, ledger) => {
    const payment = ledger.initiate(crypto.randomUUID(), { amount: 1200, currency: 'USD', ownerId: 'employer-1' });
    const event = { providerEventId: 'evt_123', paymentId: payment.paymentId, eventType: 'authorized', payload: { id: 'evt_123', cardNumber: '4111111111111111', result: 'ok' } };
    assert.equal(ledger.appendWebhook(event).payment.status, 'authorized');
    assert.equal(ledger.appendWebhook(event).duplicate, true);
    assert.equal(database.prepare('SELECT count(*) AS count FROM payment_events').get().count, 2);
    assert.equal(ledger.getPayment(payment.paymentId, 'employer-2'), null);
    assert.equal(ledger.getPayment(payment.paymentId, 'employer-1').events[1].payload_json, undefined);
    const storedPayload = JSON.parse(database.prepare('SELECT payload_json FROM payment_events WHERE provider_event_id = ?').get('evt_123').payload_json);
    assert.equal(storedPayload.cardNumber, undefined);
    assert.equal(storedPayload.result, 'ok');
    assert.throws(() => database.prepare('UPDATE payment_events SET event_type = ?').run('captured'), /append-only/);
  });
});

test('status transitions and webhook signatures are validated', () => {
  assert.throws(() => derivePaymentStatus([
    { event_type: 'initiated' }, { event_type: 'refunded' }
  ]), /Invalid payment transition/);
  const body = Buffer.from('{"id":"evt_123"}');
  const signature = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, `sha256=${signature}`, 'test-secret'), true);
  assert.equal(verifyWebhookSignature(body, signature, 'wrong-secret'), false);
});