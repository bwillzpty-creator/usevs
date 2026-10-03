const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const projectRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

function hasLivePayFastConfiguration(environment) {
  const sandboxSetting = environment.PAYFAST_SANDBOX;
  const isSandbox = sandboxSetting === undefined
    ? environment.PAYFAST_MODE !== 'live'
    : sandboxSetting.trim().toLowerCase() !== 'false';
  if (isSandbox) return false;

  const requiredValues = [
    environment.PAYFAST_MERCHANT_ID,
    environment.PAYFAST_MERCHANT_KEY,
    environment.PAYFAST_PASSPHRASE,
    environment.PAYFAST_RETURN_URL,
    environment.PAYFAST_CANCEL_URL,
    environment.PAYFAST_NOTIFY_URL
  ];
  const hasHttpsCallbacks = requiredValues.slice(3).every((value) =>
    typeof value === 'string' && value.startsWith('https://')
  );
  const onceOffAmount = Number(environment.PAYFAST_ONCE_OFF_AMOUNT);
  const subscriptionAmount = Number(environment.PAYFAST_SUBSCRIPTION_AMOUNT);
  const annualAmount = Number(environment.PAYFAST_ANNUAL_AMOUNT || 269.99);

  return requiredValues.slice(0, 3).every(Boolean) &&
    hasHttpsCallbacks &&
    Number.isFinite(onceOffAmount) && onceOffAmount >= 4.99 &&
    Number.isFinite(subscriptionAmount) && subscriptionAmount >= 4.99 &&
    Number.isFinite(annualAmount) && annualAmount >= 4.99;
}

function writeLaunchConfig(environment = process.env) {
  const outputDirectory = path.join(projectRoot, 'public');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'launch-config.js');
  const premiumPaymentsEnabled = hasLivePayFastConfiguration(environment);
  fs.writeFileSync(
    outputPath,
    `window.USEVS_LAUNCH_CONFIG = Object.freeze({ premiumPaymentsEnabled: ${premiumPaymentsEnabled} });\n`,
    'utf8'
  );
  return premiumPaymentsEnabled;
}

if (require.main === module) {
  try {
    const enabled = writeLaunchConfig();
    console.log(`Premium controls ${enabled ? 'enabled' : 'hidden'} for this launch.`);
  } catch (error) {
    console.error('Unable to generate launch configuration:', error);
    process.exitCode = 1;
  }
}

module.exports = { hasLivePayFastConfiguration, writeLaunchConfig };
