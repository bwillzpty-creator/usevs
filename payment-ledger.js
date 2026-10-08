const crypto = require('node:crypto');

const PAYMENT_STATES = new Set(['initiated', 'authorized', 'captured', 'refunded', 'disputed']);
const TRANSITIONS = {
  initiated: new Set(['authorized']),
  authorized: new Set(['captured', 'refunded', 'disputed']),
  captured: new Set(['refunded', 'disputed']),
  refunded: new Set(),
  disputed: new Set(['refunded'])
};

function safeEqualHex(left, right) {
  if (!/^[a-f\d]{64}$/i.test(left) || !/^[a-f\d]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof secret !== 'string' || !secret || typeof signature !== 'string') return false;
  const supplied = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(supplied, expected);
}

function sanitizeWebhookPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeWebhookPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(card|pan|cvc|cvv|security.?code|account.?number|password|secret|token|authorization|email|phone|address)/i.test(key))
    .map(([key, item]) => [key, sanitizeWebhookPayload(item)]));
}

function derivePaymentStatus(events) {
  let status = null;
  for (const event of events) {
    if (!PAYMENT_STATES.has(event.event_type)) throw new Error('Unknown payment event state.');
    if (status === null) {
      if (event.event_type !== 'initiated') throw new Error('A payment timeline must begin with initiated.');
      status = event.event_type;
      continue;
    }
    if (!TRANSITIONS[status].has(event.event_type)) {
      throw new Error(`Invalid payment transition: ${status} -> ${event.event_type}.`);
    }
    status = event.event_type;
  }
  return status;
}

function createPaymentLedger(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS payment_idempotency_keys (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      payment_id TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('initiated', 'authorized', 'captured', 'refunded', 'disputed')),
      source TEXT NOT NULL CHECK (source IN ('api', 'webhook')),
      provider_event_id TEXT UNIQUE,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payment_events_by_payment ON payment_events(payment_id, event_sequence);
    CREATE TRIGGER IF NOT EXISTS payment_events_no_update
      BEFORE UPDATE ON payment_events BEGIN SELECT RAISE(ABORT, 'payment_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS payment_events_no_delete
      BEFORE DELETE ON payment_events BEGIN SELECT RAISE(ABORT, 'payment_events is append-only'); END;
  `);

  const timeline = (paymentId) => database.prepare(
    'SELECT owner_id, event_type, source, provider_event_id, payload_json, occurred_at, recorded_at FROM payment_events WHERE payment_id = ? ORDER BY event_sequence'
  ).all(paymentId);

  function getPayment(paymentId, ownerId) {
    const events = timeline(paymentId);
    if (!events.length) return null;
    if (ownerId && events[0].owner_id !== ownerId) return null;
    return {
      paymentId,
      status: derivePaymentStatus(events),
      events: events.map((event) => ({
        eventType: event.event_type,
        source: event.source,
        providerEventId: event.provider_event_id,
        occurredAt: event.occurred_at,
        recordedAt: event.recorded_at
      }))
    };
  }

  function initiate(idempotencyKey, request) {
    if (typeof idempotencyKey !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      throw new Error('A valid UUID Idempotency-Key is required.');
    }
    const requestJson = JSON.stringify(request);
    const requestHash = crypto.createHash('sha256').update(requestJson).digest('hex');
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database.prepare('SELECT request_hash, payment_id FROM payment_idempotency_keys WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error('Idempotency key was already used with a different request.');
        database.exec('COMMIT');
        return { ...getPayment(existing.payment_id), replayed: true };
      }
      const paymentId = crypto.randomUUID();
      const now = new Date().toISOString();
      database.prepare('INSERT INTO payment_idempotency_keys (idempotency_key, request_hash, payment_id, received_at) VALUES (?, ?, ?, ?)')
        .run(idempotencyKey, requestHash, paymentId, now);
      if (typeof request.ownerId !== 'string' || !request.ownerId) throw new Error('Payment owner is required.');
      database.prepare(`INSERT INTO payment_events (payment_id, owner_id, event_type, source, payload_json, occurred_at, recorded_at)
        VALUES (?, ?, 'initiated', 'api', ?, ?, ?)`).run(paymentId, request.ownerId, requestJson, now, now);
      database.exec('COMMIT');
      return { ...getPayment(paymentId), replayed: false };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function appendWebhook({ providerEventId, paymentId, eventType, payload, occurredAt }) {
    if (typeof providerEventId !== 'string' || !providerEventId.trim() || providerEventId.length > 200) {
      throw new Error('A valid provider event ID is required.');
    }
    if (typeof paymentId !== 'string' || !paymentId.trim() || !PAYMENT_STATES.has(eventType) || eventType === 'initiated') {
      throw new Error('The webhook payment event is invalid.');
    }
    const existing = database.prepare('SELECT payment_id FROM payment_events WHERE provider_event_id = ?').get(providerEventId);
    if (existing) return { duplicate: true, payment: getPayment(existing.payment_id) };

    const currentEvents = timeline(paymentId);
    if (!currentEvents.length) throw new Error('The payment does not exist.');
    derivePaymentStatus([...currentEvents, { event_type: eventType }]);
    const now = new Date().toISOString();
    try {
      database.prepare(`INSERT INTO payment_events
        (payment_id, owner_id, event_type, source, provider_event_id, payload_json, occurred_at, recorded_at)
        VALUES (?, ?, ?, 'webhook', ?, ?, ?, ?)`)
        .run(paymentId, currentEvents[0].owner_id, eventType, providerEventId, JSON.stringify(sanitizeWebhookPayload(payload)), occurredAt || now, now);
    } catch (error) {
      if (error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
        const duplicate = database.prepare('SELECT payment_id FROM payment_events WHERE provider_event_id = ?').get(providerEventId);
        if (duplicate) return { duplicate: true, payment: getPayment(duplicate.payment_id) };
      }
      throw error;
    }
    return { duplicate: false, payment: getPayment(paymentId) };
  }

  return { appendWebhook, getPayment, initiate };
}

module.exports = { createPaymentLedger, derivePaymentStatus, verifyWebhookSignature };