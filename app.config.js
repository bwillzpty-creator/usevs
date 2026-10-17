const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_DEFINITIONS = Object.freeze({
  single_use: Object.freeze({
    durationMs: DAY_MS,
    maxEmployees: 1,
    maxLetters: 1,
    gumroadLink: 'https://usevs.gumroad.com/l/Single-Use?wanted=true'
  }),
  monthly: Object.freeze({
    durationMs: 30 * DAY_MS,
    maxEmployees: 50,
    maxLetters: null,
    gumroadLink: 'https://usevs.gumroad.com/l/RecruiterPro?wanted=true'
  }),
  yearly: Object.freeze({
    durationMs: 365 * DAY_MS,
    maxEmployees: null,
    maxLetters: null,
    gumroadLink: 'https://usevs.gumroad.com/l/EnterpriseVault?wanted=true'
  })
});

const EXPIRED_BANNER = 'Your subscription or pass has expired. You cannot generate new verification letters until you renew your subscription or buy a 1-day pass.';

function createAppConfig(env = process.env) {
  return {
    plans: Object.fromEntries(Object.entries(PLAN_DEFINITIONS).map(([planCode, plan]) => [planCode, {
      ...plan,
      productId: env[`GUMROAD_${planCode.toUpperCase()}_PRODUCT_ID`] || ''
    }])),
    gumroadLinks: {
      singleUse: PLAN_DEFINITIONS.single_use.gumroadLink,
      monthly: PLAN_DEFINITIONS.monthly.gumroadLink,
      yearly: PLAN_DEFINITIONS.yearly.gumroadLink
    },
    expiredBanner: EXPIRED_BANNER
  };
}

module.exports = { DAY_MS, EXPIRED_BANNER, PLAN_DEFINITIONS, createAppConfig };
