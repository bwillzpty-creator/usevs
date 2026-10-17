const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAppConfig } = require('../app.config');

const GUMROAD_LICENSE_VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
const GUMROAD_EVENT_TYPES = new Set(['purchase', 'refund', 'chargeback', 'cancellation', 'renewal']);

function isTrue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function getPurchaseId(purchase) {
  return String(purchase?.purchase_id || purchase?.sale_id || purchase?.id || '').trim();
}

function getPurchaseTime(purchase, fallback) {
  const candidates = [
    purchase?.purchase_time,
    purchase?.created_at,
    purchase?.sale_timestamp,
    purchase?.timestamp
  ];
  for (const value of candidates) {
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(time)) return new Date(time < 1e12 ? time * 1000 : time);
  }
  return new Date(fallback);
}

function normalizeEventType(payload) {
  const explicit = String(payload?.event_type || payload?.event || payload?.type || '').toLowerCase();
  const state = String(payload?.status || '').toLowerCase();
  if (isTrue(payload?.chargebacked) || isTrue(payload?.disputed) ||
      ['chargeback', 'chargebacked', 'dispute', 'disputed'].includes(explicit)) return 'chargeback';
  if (isTrue(payload?.refunded) || ['refund', 'refunded'].includes(explicit)) return 'refund';
  if (payload?.subscription_cancelled_at || payload?.subscription_canceled_at ||
      isTrue(payload?.cancelled) || isTrue(payload?.canceled) ||
      ['cancel', 'cancelled', 'canceled', 'cancellation', 'subscription_cancelled', 'subscription_canceled'].includes(explicit)) {
    return 'cancellation';
  }
  if (['renewal', 'renewed', 'subscription_renewal', 'subscription_payment'].includes(explicit)) return 'renewal';
  if (['purchase', 'sale', 'sale_success', 'payment_succeeded'].includes(explicit) || state === 'purchase') return 'purchase';
  return GUMROAD_EVENT_TYPES.has(explicit) ? explicit : null;
}

function normalizePlanCode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const aliases = {
    '1day': 'single_use',
    '1_day': 'single_use',
    single_use: 'single_use',
    singleuse: 'single_use',
    monthly: 'monthly',
    '1_month': 'monthly',
    yearly: 'yearly',
    '1_year': 'yearly'
  };
  return aliases[normalized] || null;
}

function sanitizePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(license.?key|email|phone|address|password|token|secret|card|cvc|cvv)/i.test(key))
    .map(([key, child]) => [key, sanitizePayload(child)]));
}

function createPostHogTracker({ apiKey = process.env.POSTHOG_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  return async (event, distinctId, properties = {}) => {
    if (!apiKey) return false;
    const response = await fetchImpl('https://us.i.posthog.com/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: distinctId,
        properties
      })
    });
    if (!response.ok) throw new Error(`PostHog event delivery failed with HTTP ${response.status}.`);
    return true;
  };
}

function createGumroadService({
  accessModel,
  eventModel,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  eventStoragePath = path.join(process.cwd(), 'data', 'gumroad-events'),
  resolveEmployerIdByEmail,
  analytics,
  logger = console
}) {
  if (!accessModel || !eventModel) throw new Error('Gumroad access and event models are required.');
  const config = createAppConfig(env);
  const analyticsTracker = analytics || createPostHogTracker({ apiKey: env.POSTHOG_API_KEY, fetchImpl });

  async function trackEvent(event, distinctId, properties) {
    try {
      return await analyticsTracker(event, distinctId, properties);
    } catch (error) {
      logger.error(`Unable to send PostHog event "${event}":`, error);
      return false;
    }
  }

  function mapGumroadProductToPlan(productId) {
    const entry = Object.entries(config.plans).find(([, plan]) => plan.productId && plan.productId === String(productId));
    return entry ? entry[0] : null;
  }

  function createCheckoutUrl(plan, email, returnUrl) {
    const planCode = normalizePlanCode(plan);
    const address = typeof email === 'string' ? email.trim() : '';
    if (!planCode || !config.plans[planCode]?.productId) throw new Error('Choose a configured Gumroad plan.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('A valid employer email is required for checkout.');
    const url = new URL(config.plans[planCode].gumroadLink);
    url.searchParams.set('email', address);
    if (returnUrl) {
      const redirect = new URL(returnUrl);
      if (!['http:', 'https:'].includes(redirect.protocol)) throw new Error('A valid payment return URL is required.');
      url.searchParams.set('redirect_url', redirect.toString());
    }
    return url.toString();
  }

  async function verifyLicenseWithGumroadAPI(licenseKey, expectedPurchaseId) {
    if (typeof licenseKey !== 'string' || !licenseKey.trim() || licenseKey.length > 512) {
      throw new Error('A valid Gumroad license key is required.');
    }
    if (!env.GUMROAD_API_KEY) throw new Error('Gumroad API is not configured.');
    const configuredPlans = Object.entries(config.plans).filter(([, plan]) => plan.productId);
    if (!configuredPlans.length) throw new Error('No Gumroad product IDs are configured.');

    let lastFailure = 'The Gumroad license could not be verified.';
    for (const [planCode, plan] of configuredPlans) {
      const form = new URLSearchParams({
        product_id: plan.productId,
        license_key: licenseKey.trim(),
        increment_uses_count: 'false',
        access_token: env.GUMROAD_API_KEY
      });
      const response = await fetchImpl(GUMROAD_LICENSE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error('Gumroad returned an invalid license-verification response.', { cause: error });
      }
      if (!body || typeof body !== 'object') {
        throw new Error('Gumroad returned an invalid license-verification response.');
      }
      if (!response.ok) throw new Error(body?.message || `Gumroad license verification failed with HTTP ${response.status}.`);
      const purchase = body.purchase || body;
      if (!body.success || !purchase) {
        lastFailure = body.message || lastFailure;
        continue;
      }
      const returnedProductId = String(purchase.product_id || plan.productId);
      const returnedLicenseKey = String(purchase.license_key || licenseKey.trim());
      const purchaseId = getPurchaseId(purchase);
      if (returnedProductId !== plan.productId || returnedLicenseKey !== licenseKey.trim() || !purchaseId) {
        lastFailure = 'Gumroad returned purchase details that do not match the license.';
        continue;
      }
      if (expectedPurchaseId && purchaseId !== String(expectedPurchaseId)) {
        lastFailure = 'The Gumroad purchase ID does not match the submitted purchase.';
        continue;
      }
      const refunded = isTrue(purchase.refunded);
      const chargebacked = isTrue(purchase.chargebacked) || isTrue(purchase.disputed);
      const subscriptionCancelled = Boolean(purchase.subscription_cancelled_at || purchase.subscription_canceled_at);
      const subscriptionEnded = Boolean(purchase.subscription_ended_at);
      const subscriptionFailed = Boolean(purchase.subscription_failed_at);
      return {
        verified: true,
        valid: !refunded && !chargebacked && !subscriptionEnded && !subscriptionFailed,
        licenseKey: returnedLicenseKey,
        productId: returnedProductId,
        purchaseId,
        planCode,
        purchaseTime: getPurchaseTime(purchase, now()),
        email: String(purchase.email || '').trim().toLowerCase(),
        refunded,
        chargebacked,
        subscriptionCancelled,
        subscriptionEnded,
        subscriptionFailed,
        rawPurchase: purchase
      };
    }
    return { verified: false, valid: false, reason: lastFailure };
  }

  function calculateExpiry(planCode, purchaseTime) {
    const plan = config.plans[planCode];
    if (!plan) throw new Error('Unknown Gumroad plan.');
    const start = new Date(purchaseTime);
    if (!Number.isFinite(start.getTime())) throw new Error('The Gumroad purchase time is invalid.');
    return new Date(start.getTime() + plan.durationMs).toISOString();
  }

  async function activatePlan(employerId, planCode, licenseKey, gumroadPurchaseId, expiresAt, details = {}) {
    const plan = config.plans[planCode];
    if (!employerId || !plan || !plan.productId) throw new Error('Employer or configured Gumroad plan is invalid.');
    const activationExpiry = expiresAt || calculateExpiry(planCode, now());
    const result = accessModel.activate({
      employerId,
      planCode,
      licenseKey,
      gumroadPurchaseId,
      gumroadProductId: details.productId || plan.productId,
      expiresAt: activationExpiry
    });
    if (result.changed) {
      await trackEvent('gumroad_plan_activated', employerId, {
        planCode,
        purchaseId: gumroadPurchaseId,
        expiresAt: result.access.expiresAt
      });
    }
    return result;
  }

  async function expirePlan(employerId) {
    const changed = accessModel.setStatus(employerId, 'expired');
    if (changed) await trackEvent('gumroad_plan_expired', employerId, {});
    return changed;
  }

  async function revokePlan(employerId, purchaseId) {
    const changed = accessModel.setStatus(employerId, 'revoked', purchaseId);
    if (changed) await trackEvent('gumroad_plan_revoked', employerId, { purchaseId: purchaseId || null });
    return changed;
  }

  async function getAccessStatus(employerId) {
    if (!employerId) throw new Error('Employer ID is required.');
    let access = accessModel.findActiveByEmployerId(employerId);
    const currentTime = now().getTime();
    if (access && Date.parse(access.expiresAt) <= currentTime) {
      await expirePlan(employerId);
      access = accessModel.findByEmployerId(employerId);
    }
    if (!access) access = accessModel.findByEmployerId(employerId);
    const active = Boolean(access && access.status === 'active' && Date.parse(access.expiresAt) > currentTime);
    return {
      active,
      status: access?.status || 'inactive',
      employerId,
      planCode: access?.planCode || null,
      expiresAt: access?.expiresAt || null,
      limits: access ? {
        maxEmployees: config.plans[access.planCode].maxEmployees,
        maxLetters: config.plans[access.planCode].maxLetters
      } : null
    };
  }

  async function recordGumroadEvent(payload, eventTypeOverride) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Gumroad webhook payload must be an object.');
    }
    const eventType = eventTypeOverride || normalizeEventType(payload);
    if (!eventType) throw new Error('Unsupported Gumroad event type.');
    await fs.mkdir(eventStoragePath, { recursive: true, mode: 0o700 });
    const filePath = path.join(eventStoragePath, `${crypto.randomUUID()}.json`);
    await fs.writeFile(filePath, `${JSON.stringify(sanitizePayload(payload), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    return eventModel.create(eventType, filePath);
  }

  async function handleWebhookEvent(payload) {
    const licenseKey = String(payload.license_key || payload.licenseKey || '').trim();
    const purchaseId = String(payload.sale_id || payload.purchase_id || payload.id || '').trim();
    if (!licenseKey || !purchaseId) throw new Error('Gumroad webhook is missing its license or purchase ID.');

    const previousAccess = accessModel.findByPurchaseId(purchaseId) || accessModel.findByLicenseKey(licenseKey);
    const inferredEventType = normalizeEventType(payload) ||
      (previousAccess && previousAccess.planCode !== 'single_use' ? 'renewal' : 'purchase');
    const event = await recordGumroadEvent(payload, inferredEventType);
    const verified = await verifyLicenseWithGumroadAPI(licenseKey, purchaseId);
    if (!verified.verified) throw new Error(verified.reason || 'Gumroad webhook purchase could not be verified.');

    if (event.eventType === 'refund' || event.eventType === 'chargeback') {
      const confirmed = event.eventType === 'refund' ? verified.refunded : verified.chargebacked;
      if (!confirmed || !previousAccess || previousAccess.licenseKey !== verified.licenseKey) {
        return { accepted: false, event, reason: 'The Gumroad API did not confirm this refund or chargeback.' };
      }
      const changed = await revokePlan(previousAccess.employerId, purchaseId);
      return { accepted: true, event, action: changed ? 'revoked' : 'unchanged' };
    }

    if (event.eventType === 'cancellation') {
      const cancelled = verified.subscriptionCancelled || verified.subscriptionEnded;
      if (!cancelled) return { accepted: false, event, reason: 'The Gumroad API did not confirm this cancellation.' };
      return { accepted: true, event, action: 'cancellation_recorded' };
    }

    if (!verified.valid) {
      return { accepted: false, event, reason: 'The Gumroad purchase is refunded, disputed, ended, or otherwise inactive.' };
    }
    if (event.eventType === 'renewal' && verified.planCode === 'single_use') {
      return { accepted: false, event, reason: 'A single-use pass cannot be renewed.' };
    }
    const employerId = previousAccess?.employerId ||
      (typeof resolveEmployerIdByEmail === 'function' && verified.email
        ? await resolveEmployerIdByEmail(verified.email)
        : null);
    if (!employerId) throw new Error('No registered employer account matches this Gumroad purchase.');
    const purchaseTime = getPurchaseTime(payload, verified.purchaseTime);
    const expiresAt = calculateExpiry(verified.planCode, purchaseTime);
    const activated = await activatePlan(employerId, verified.planCode, verified.licenseKey,
      verified.purchaseId, expiresAt, { productId: verified.productId });
    return { accepted: true, event, action: activated.changed ? event.eventType : 'unchanged', access: activated.access };
  }

  return {
    activatePlan,
    calculateExpiry,
    createCheckoutUrl,
    expirePlan,
    getAccessStatus,
    handleWebhookEvent,
    mapGumroadProductToPlan,
    recordGumroadEvent,
    revokePlan,
    trackEvent,
    verifyLicenseWithGumroadAPI
  };
}

module.exports = {
  GUMROAD_LICENSE_VERIFY_URL,
  createGumroadService,
  normalizePlanCode,
  normalizeEventType,
  sanitizePayload
};
