const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { createGumroadAccessModel } = require('../models/gumroad-access.model');
const { createGumroadEventModel } = require('../models/gumroad-event.model');
const { createGumroadService } = require('../services/gumroad.service');
const { createSubscriptionMiddleware } = require('../middleware/subscription.middleware');
const { EXPIRED_BANNER, PLAN_DEFINITIONS, createAppConfig } = require('../app.config');

const BASE_ENV = {
  GUMROAD_API_KEY: 'test-api-key',
  GUMROAD_SINGLE_USE_PRODUCT_ID: 'prod-single',
  GUMROAD_MONTHLY_PRODUCT_ID: 'prod-monthly',
  GUMROAD_YEARLY_PRODUCT_ID: 'prod-yearly'
};

function createHarness({ fetchImpl, now, resolveEmployerIdByEmail, analytics } = {}) {
  const database = new DatabaseSync(':memory:');
  const accessModel = createGumroadAccessModel(database);
  const eventModel = createGumroadEventModel(database);
  const tempDirectory = path.join(os.tmpdir(), `gumroad-foundation-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const service = createGumroadService({
    accessModel,
    eventModel,
    env: BASE_ENV,
    fetchImpl: fetchImpl || (async () => { throw new Error('Unexpected Gumroad request.'); }),
    now: now || (() => new Date('2026-01-01T00:00:00.000Z')),
    eventStoragePath: tempDirectory,
    resolveEmployerIdByEmail,
    analytics: analytics || (async () => {})
  });
  return { accessModel, database, eventModel, service, tempDirectory };
}

function gumroadResponse({ productId = 'prod-monthly', purchaseId = 'sale-1', email = 'hr@acme.example', createdAt = '2026-01-01T00:00:00.000Z', ...flags } = {}) {
  return {
    success: true,
    purchase: {
      product_id: productId,
      purchase_id: purchaseId,
      license_key: 'license-test',
      email,
      created_at: createdAt,
      ...flags
    }
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

test('license verification maps verified Gumroad product and validates purchase fields', async (t) => {
  const calls = [];
  const harness = createHarness({
    fetchImpl: async (_url, options) => {
      const form = new URLSearchParams(options.body);
      calls.push(form.get('product_id'));
      return {
        ok: true,
        json: async () => form.get('product_id') === 'prod-monthly'
          ? gumroadResponse()
          : { success: false }
      };
    }
  });
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });

  const result = await harness.service.verifyLicenseWithGumroadAPI('license-test', 'sale-1');
  assert.equal(result.valid, true);
  assert.equal(result.planCode, 'monthly');
  assert.equal(result.purchaseId, 'sale-1');
  assert.equal(result.productId, 'prod-monthly');
  assert.ok(calls.includes('prod-monthly'));
  assert.equal(harness.service.mapGumroadProductToPlan('prod-yearly'), 'yearly');
  assert.equal(harness.service.mapGumroadProductToPlan('unknown-product'), null);
  assert.equal((await harness.service.verifyLicenseWithGumroadAPI('license-test', 'wrong-sale')).verified, false);
  const checkout = new URL(harness.service.createCheckoutUrl('1day', 'hr+recruiting@acme.example'));
  assert.equal(checkout.hostname, 'usevs.gumroad.com');
  assert.equal(checkout.searchParams.get('email'), 'hr+recruiting@acme.example');
  assert.throws(() => harness.service.createCheckoutUrl('monthly', 'not-an-email'), /valid employer email/);
});

test('activation applies exact duration and configured employee and letter limits', async (t) => {
  const harness = createHarness();
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });
  const expiresAt = harness.service.calculateExpiry('single_use', '2026-02-01T03:00:00.000Z');
  assert.equal(expiresAt, '2026-02-02T03:00:00.000Z');
  const activated = await harness.service.activatePlan(
    'employer-1', 'single_use', 'license-test', 'sale-1', expiresAt, { productId: 'prod-single' }
  );
  assert.equal(activated.access.status, 'active');
  assert.deepEqual(activated.access, harness.accessModel.findByEmployerId('employer-1'));
  assert.deepEqual((await harness.service.getAccessStatus('employer-1')).limits, {
    maxEmployees: 1,
    maxLetters: 1
  });
  assert.equal(PLAN_DEFINITIONS.monthly.durationMs, 30 * 86400000);
  assert.equal(PLAN_DEFINITIONS.yearly.durationMs, 365 * 86400000);
  assert.equal(harness.service.calculateExpiry('monthly', '2026-02-01T00:00:00.000Z'), '2026-03-03T00:00:00.000Z');
  assert.equal(harness.service.calculateExpiry('yearly', '2026-02-01T00:00:00.000Z'), '2027-02-01T00:00:00.000Z');
  assert.equal(createAppConfig(BASE_ENV).plans.yearly.maxEmployees, null);
  assert.equal(createAppConfig(BASE_ENV).plans.monthly.maxLetters, null);
});

test('expired plans are marked expired and emit the expiration event once', async (t) => {
  const tracked = [];
  const harness = createHarness({ analytics: async (...args) => tracked.push(args) });
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });
  await harness.service.activatePlan(
    'employer-1', 'monthly', 'license-test', 'sale-1', '2025-12-31T00:00:00.000Z'
  );
  const access = await harness.service.getAccessStatus('employer-1');
  assert.equal(access.active, false);
  assert.equal(access.status, 'expired');
  assert.equal(tracked.filter(([event]) => event === 'gumroad_plan_expired').length, 1);
  await harness.service.getAccessStatus('employer-1');
  assert.equal(tracked.filter(([event]) => event === 'gumroad_plan_expired').length, 1);
});

test('verified subscription renewal activates the renewed term and records a sanitized event', async (t) => {
  const harness = createHarness({
    fetchImpl: async () => ({ ok: true, json: async () => gumroadResponse({
      purchaseId: 'sale-renewal',
      createdAt: '2026-02-01T00:00:00.000Z'
    }) }),
    resolveEmployerIdByEmail: async () => 'employer-1'
  });
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });
  await harness.service.activatePlan(
    'employer-1', 'monthly', 'license-test', 'sale-original', '2026-02-01T00:00:00.000Z'
  );
  const result = await harness.service.handleWebhookEvent({
    sale_id: 'sale-renewal',
    license_key: 'license-test',
    email: 'hr@acme.example',
    created_at: '2026-02-01T00:00:00.000Z'
  });
  assert.equal(result.accepted, true);
  assert.equal(result.access.expiresAt, '2026-03-03T00:00:00.000Z');
  assert.equal(harness.eventModel.listRecent()[0].eventType, 'renewal');
  const savedPayload = await fs.readFile(harness.eventModel.listRecent()[0].rawPayloadPath, 'utf8');
  assert.equal(savedPayload.includes('license-test'), false);
});

test('refund/chargeback revocation requires Gumroad API confirmation', async (t) => {
  let refunded = false;
  const harness = createHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => gumroadResponse({ purchaseId: 'sale-1', refunded })
    })
  });
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });
  await harness.service.activatePlan(
    'employer-1', 'monthly', 'license-test', 'sale-1', '2026-03-01T00:00:00.000Z'
  );
  const rejected = await harness.service.handleWebhookEvent({
    event_type: 'refund', sale_id: 'sale-1', license_key: 'license-test'
  });
  assert.equal(rejected.accepted, false);
  assert.equal((await harness.service.getAccessStatus('employer-1')).active, true);

  refunded = true;
  const accepted = await harness.service.handleWebhookEvent({
    event_type: 'refund', sale_id: 'sale-1', license_key: 'license-test'
  });
  assert.equal(accepted.action, 'revoked');
  assert.equal((await harness.service.getAccessStatus('employer-1')).status, 'revoked');

  await harness.service.activatePlan(
    'employer-1', 'monthly', 'license-test', 'sale-2', '2026-03-01T00:00:00.000Z'
  );
  refunded = false;
  const chargebackHarness = createHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => gumroadResponse({ purchaseId: 'sale-2', chargebacked: true })
    })
  });
  t.after(async () => {
    chargebackHarness.database.close();
    await fs.rm(chargebackHarness.tempDirectory, { recursive: true, force: true });
  });
  await chargebackHarness.service.activatePlan(
    'employer-1', 'monthly', 'license-test', 'sale-2', '2026-03-01T00:00:00.000Z'
  );
  const chargedBack = await chargebackHarness.service.handleWebhookEvent({
    event_type: 'chargeback',
    sale_id: 'sale-2',
    license_key: 'license-test'
  });
  assert.equal(chargedBack.action, 'revoked');
  assert.equal((await chargebackHarness.service.getAccessStatus('employer-1')).status, 'revoked');
});

test('cancellation is recorded while access remains active through its paid expiry', async (t) => {
  const harness = createHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => gumroadResponse({ purchaseId: 'sale-1', subscription_cancelled_at: '2026-01-01T00:00:00Z' })
    })
  });
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });
  await harness.service.activatePlan(
    'employer-1', 'monthly', 'license-test', 'sale-1', '2026-02-01T00:00:00.000Z'
  );
  const result = await harness.service.handleWebhookEvent({
    event_type: 'cancellation', sale_id: 'sale-1', license_key: 'license-test'
  });
  assert.equal(result.action, 'cancellation_recorded');
  assert.equal((await harness.service.getAccessStatus('employer-1')).active, true);
});

test('access middleware returns expired banner and enforces employee and letter limits', async (t) => {
  const harness = createHarness();
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });
  await harness.service.activatePlan(
    'employer-1', 'single_use', 'license-test', 'sale-1', '2025-12-31T00:00:00.000Z'
  );
  const middleware = createSubscriptionMiddleware({
    service: harness.service,
    getUsageCount: async () => 1
  });
  const req = { issuerContext: { employer: { id: 'employer-1' } } };

  const gateRes = makeResponse();
  let gateContinued = false;
  await middleware.requireActiveGumroadPlan()(req, gateRes, () => { gateContinued = true; });
  assert.equal(gateContinued, false);
  assert.equal(gateRes.statusCode, 402);
  assert.equal(gateRes.body.banner, EXPIRED_BANNER);
  assert.equal(gateRes.body.action, 'renew');
  assert.deepEqual(Object.keys(gateRes.body), ['banner', 'action']);

  await harness.service.activatePlan(
    'employer-1', 'single_use', 'license-test', 'sale-2', '2026-02-01T00:00:00.000Z'
  );
  req.gumroadAccess = await harness.service.getAccessStatus('employer-1');
  const limitRes = makeResponse();
  let limitContinued = false;
  await middleware.enforcePlanLimit('employees')(req, limitRes, () => { limitContinued = true; });
  assert.equal(limitContinued, false);
  assert.equal(limitRes.statusCode, 402);
  assert.match(limitRes.body.message, /allows 1 employee/);
  assert.equal(limitRes.body.banner, undefined);

  const letterLimitRes = makeResponse();
  let letterLimitContinued = false;
  await middleware.enforcePlanLimit('letters')(req, letterLimitRes, () => { letterLimitContinued = true; });
  assert.equal(letterLimitContinued, false);
  assert.equal(letterLimitRes.statusCode, 402);
  assert.match(letterLimitRes.body.message, /allows 1 letter/);

  await harness.service.activatePlan(
    'employer-1', 'monthly', 'license-test', 'sale-3', '2026-02-01T00:00:00.000Z'
  );
  req.gumroadAccess = await harness.service.getAccessStatus('employer-1');
  const monthlyLimitRes = makeResponse();
  await middleware.enforcePlanLimit('employees', async () => 50)(req, monthlyLimitRes, () => {});
  assert.equal(monthlyLimitRes.statusCode, 402);
  assert.match(monthlyLimitRes.body.message, /allows 50 employees/);

  await harness.service.activatePlan(
    'employer-1', 'yearly', 'license-test', 'sale-4', '2027-02-01T00:00:00.000Z'
  );
  req.gumroadAccess = await harness.service.getAccessStatus('employer-1');
  let yearlyContinued = false;
  const yearlyMiddleware = createSubscriptionMiddleware({
    service: harness.service,
    getUsageCount: async () => 5000,
    logger: { error() {} }
  });
  await yearlyMiddleware.enforcePlanLimit('employees')(req, makeResponse(), () => { yearlyContinued = true; });
  assert.equal(yearlyContinued, true);
});

test('expired history remains readable in view-only mode', (t) => {
  const harness = createHarness();
  t.after(async () => {
    harness.database.close();
    await fs.rm(harness.tempDirectory, { recursive: true, force: true });
  });
  const middleware = createSubscriptionMiddleware({ service: harness.service, logger: { error() {} } });
  const req = {};
  let continued = false;
  middleware.allowHistoryReadOnly(req, makeResponse(), () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.gumroadHistoryViewOnly, true);
});
