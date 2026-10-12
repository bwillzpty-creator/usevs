const crypto = require('node:crypto');

const STRIPE_API = 'https://api.stripe.com/v1';
const WEBHOOK_TOLERANCE_SECONDS = 300;

// Default prices in USD cents; override per plan with PLAN_PRICE_<TIER>_CENTS.
const PLANS = {
  '1_day': { label: '1-Day Access', defaultCents: 499 },
  '1_week': { label: '1-Week Access', defaultCents: 1299 },
  '1_month': { label: '1-Month Access', defaultCents: 2499 },
  '1_year': { label: '1-Year Access', defaultCents: 26999 }
};

function planPriceCents(tier, env = process.env) {
  const plan = PLANS[tier];
  if (!plan) return null;
  const configured = Number(env[`PLAN_PRICE_${tier.toUpperCase()}_CENTS`]);
  return Number.isInteger(configured) && configured >= 50 ? configured : plan.defaultCents;
}

function listPlans(env = process.env) {
  return Object.entries(PLANS).map(([id, plan]) => ({ id, label: plan.label, priceCents: planPriceCents(id, env) }));
}

async function stripeRequest(method, pathname, secretKey, form) {
  const response = await fetch(`${STRIPE_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    },
    body: form ? new URLSearchParams(form).toString() : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || 'Payment provider request failed.');
  return body;
}

function createCheckoutSession({ secretKey, tier, email, accountId, baseUrl, env = process.env }) {
  const plan = PLANS[tier];
  if (!plan) throw new Error('Unknown plan.');
  return stripeRequest('POST', '/checkout/sessions', secretKey, {
    mode: 'payment',
    customer_email: email,
    client_reference_id: accountId,
    success_url: `${baseUrl}/api/checkout/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/select-plan`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(planPriceCents(tier, env)),
    'line_items[0][price_data][product_data][name]': `US-EVS ${plan.label}`,
    'metadata[tier]': tier,
    'metadata[account_email]': email
  });
}

function retrieveCheckoutSession(secretKey, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) throw new Error('Invalid checkout session.');
  return stripeRequest('GET', `/checkout/sessions/${sessionId}`, secretKey);
}

function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || !secret) return false;
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || !signatures.length || Math.abs(nowSeconds - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return signatures.some((signature) =>
    signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)));
}

// Returns { tier, email, saleId } for a paid session whose tier and amount match our catalog, otherwise null.
function paidSessionDetails(session, env = process.env) {
  if (!session || session.payment_status !== 'paid') return null;
  const tier = session.metadata?.tier;
  const email = session.metadata?.account_email;
  if (!PLANS[tier] || !email) return null;
  if (session.currency !== 'usd' || session.amount_total !== planPriceCents(tier, env)) return null;
  return { tier, email, saleId: session.id, accountId: session.client_reference_id };
}

module.exports = {
  PLANS,
  planPriceCents,
  listPlans,
  createCheckoutSession,
  retrieveCheckoutSession,
  verifyStripeSignature,
  paidSessionDetails
};
