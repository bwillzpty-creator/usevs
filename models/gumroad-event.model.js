const crypto = require('node:crypto');

const EVENT_TYPES = new Set(['purchase', 'refund', 'chargeback', 'cancellation', 'renewal']);

function createGumroadEventModel(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gumroad_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL CHECK (event_type IN ('purchase', 'refund', 'chargeback', 'cancellation', 'renewal')),
      raw_payload_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gumroad_events_by_type_date
      ON gumroad_events(event_type, created_at DESC);
  `);

  function create(eventType, rawPayloadPath) {
    if (!EVENT_TYPES.has(eventType) || typeof rawPayloadPath !== 'string' || !rawPayloadPath) {
      throw new Error('Gumroad event details are invalid.');
    }
    const event = {
      id: crypto.randomUUID(),
      eventType,
      rawPayloadPath,
      createdAt: new Date().toISOString()
    };
    database.prepare(`INSERT INTO gumroad_events (id, event_type, raw_payload_path, created_at)
      VALUES (?, ?, ?, ?)`).run(event.id, event.eventType, event.rawPayloadPath, event.createdAt);
    return event;
  }

  function listRecent(limit = 100) {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return database.prepare(`SELECT id, event_type AS eventType, raw_payload_path AS rawPayloadPath,
      created_at AS createdAt FROM gumroad_events ORDER BY created_at DESC LIMIT ?`).all(boundedLimit);
  }

  return { create, listRecent };
}

module.exports = { EVENT_TYPES, createGumroadEventModel };
