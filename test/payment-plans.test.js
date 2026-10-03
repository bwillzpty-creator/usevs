const assert = require('node:assert/strict');
const test = require('node:test');
const { getAccessExpiration, getPaymentPlan, hasActivePremiumAccess } = require('../payment-plans');

test('annual PayFast plan charges the annual price once per year', () => {
  assert.deepEqual(getPaymentPlan('annual-subscription', {}), {
    amountSetting: 'PAYFAST_ANNUAL_AMOUNT',
    amount: 269.99,
    recurring: true,
    frequency: 4,
    itemName: 'Employment Verification Premium Annual Subscription'
  });
});

test('annual amount can be overridden by the deployment environment', () => {
  assert.equal(getPaymentPlan('annual-subscription', { PAYFAST_ANNUAL_AMOUNT: '269.99' }).amount, 269.99);
});

test('annual payment access expires exactly 365 days after confirmed payment', () => {
  const paidAt = '2026-10-03T09:00:00.000Z';
  const expectedExpiration = new Date(new Date(paidAt).getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(getAccessExpiration('annual-subscription', paidAt), expectedExpiration);
});

test('monthly and one-off payments do not receive annual access expiration', () => {
  assert.equal(getAccessExpiration('subscription', '2026-10-03T09:00:00.000Z'), undefined);
  assert.equal(getAccessExpiration('once-off', '2026-10-03T09:00:00.000Z'), undefined);
});

test('annual access is active before expiry and inactive at expiry', () => {
  const payment = {
    status: 'COMPLETE',
    premium: true,
    access_expires_at: '2027-10-03T09:00:00.000Z'
  };
  assert.equal(hasActivePremiumAccess(payment, Date.parse('2027-10-03T08:59:59.999Z')), true);
  assert.equal(hasActivePremiumAccess(payment, Date.parse('2027-10-03T09:00:00.000Z')), false);
  assert.equal(hasActivePremiumAccess({ ...payment, status: 'PENDING' }, 0), false);
});

test('annual access expiration rejects invalid payment dates', () => {
  assert.throws(() => getAccessExpiration('annual-subscription', 'invalid'), RangeError);
});
