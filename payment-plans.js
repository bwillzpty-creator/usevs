const YEAR_IN_MILLISECONDS = 365 * 24 * 60 * 60 * 1000;

function getPaymentPlan(paymentType, environment = process.env) {
  if (paymentType === 'once-off') {
    return {
      amountSetting: 'PAYFAST_ONCE_OFF_AMOUNT',
      amount: Number(environment.PAYFAST_ONCE_OFF_AMOUNT),
      recurring: false,
      itemName: 'Employment Verification Premium'
    };
  }
  if (paymentType === 'subscription') {
    return {
      amountSetting: 'PAYFAST_SUBSCRIPTION_AMOUNT',
      amount: Number(environment.PAYFAST_SUBSCRIPTION_AMOUNT),
      recurring: true,
      frequency: Number(environment.PAYFAST_SUBSCRIPTION_FREQUENCY || 3),
      itemName: 'Employment Verification Premium Monthly Subscription'
    };
  }
  if (paymentType === 'annual-subscription') {
    return {
      amountSetting: 'PAYFAST_ANNUAL_AMOUNT',
      amount: Number(environment.PAYFAST_ANNUAL_AMOUNT || 269.99),
      recurring: true,
      frequency: 4,
      itemName: 'Employment Verification Premium Annual Subscription'
    };
  }
  return null;
}

function getAccessExpiration(paymentType, paidAt) {
  if (paymentType !== 'annual-subscription') return undefined;
  const paidAtMilliseconds = new Date(paidAt).getTime();
  if (!Number.isFinite(paidAtMilliseconds)) throw new RangeError('Annual access requires a valid payment date.');
  return new Date(paidAtMilliseconds + YEAR_IN_MILLISECONDS).toISOString();
}

function hasActivePremiumAccess(payment, now = Date.now()) {
  if (payment?.status !== 'COMPLETE' || payment.premium !== true) return false;
  if (!payment.access_expires_at) return true;
  const expiresAt = Date.parse(payment.access_expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

module.exports = { getAccessExpiration, getPaymentPlan, hasActivePremiumAccess };
