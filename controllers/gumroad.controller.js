const { createAppConfig } = require('../app.config');

function createGumroadController({ service } = {}) {
  if (!service) throw new Error('Gumroad service is required.');

  async function verifyLicenseKey(req, res) {
    const employerId = req.issuerContext?.employer?.id || req.employer?.id || req.auth?.employerId;
    if (!employerId) return res.status(401).json({ success: false, message: 'Authenticated employer context is missing.' });
    const licenseKey = typeof req.body?.licenseKey === 'string' ? req.body.licenseKey.trim() : '';
    if (!licenseKey) return res.status(400).json({ success: false, message: 'A Gumroad license key is required.' });
    try {
      const purchase = await service.verifyLicenseWithGumroadAPI(licenseKey, req.body?.purchaseId);
      if (!purchase.valid) return res.status(400).json({
        success: false,
        message: purchase.reason || 'The Gumroad license is invalid, refunded, disputed, or expired.'
      });
      const allowedEmails = [
        req.issuerContext?.officer?.email,
        req.issuerContext?.employer?.businessEmail,
        req.employer?.email
      ].filter(Boolean).map((email) => String(email).trim().toLowerCase());
      if (purchase.email && allowedEmails.length && !allowedEmails.includes(purchase.email)) {
        return res.status(403).json({ success: false, message: 'The Gumroad purchase email must match this employer account.' });
      }
      const expiresAt = service.calculateExpiry(purchase.planCode, purchase.purchaseTime);
      const activated = await service.activatePlan(employerId, purchase.planCode, purchase.licenseKey,
        purchase.purchaseId, expiresAt, { productId: purchase.productId });
      await service.trackEvent('gumroad_license_verified', employerId, {
        planCode: purchase.planCode,
        purchaseId: purchase.purchaseId
      });
      return res.json({ success: true, access: activated.access });
    } catch (error) {
      console.error('Unable to verify Gumroad license:', error);
      return res.status(502).json({ success: false, message: 'Unable to verify the Gumroad license right now.' });
    }
  }

  async function handleWebhookEvent(req, res) {
    try {
      const result = await service.handleWebhookEvent(req.body);
      return res.status(result.accepted ? 200 : 422).json({ success: result.accepted, ...result });
    } catch (error) {
      console.error('Unable to process Gumroad webhook:', error);
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async function createCheckout(req, res) {
    const employerId = req.issuerContext?.employer?.id || req.employer?.id || req.auth?.employerId;
    const email = req.issuerContext?.officer?.email || req.employer?.email || req.auth?.email;
    if (!employerId || !email) return res.status(401).json({ success: false, message: 'Authenticated employer context is missing.' });
    try {
      const checkoutUrl = service.createCheckoutUrl(req.body?.plan, email);
      return res.json({ success: true, checkoutUrl });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }

  async function getAccessStatus(req, res) {
    const employerId = req.issuerContext?.employer?.id || req.employer?.id || req.auth?.employerId;
    if (!employerId) return res.status(401).json({ success: false, message: 'Authenticated employer context is missing.' });
    try {
      const access = await service.getAccessStatus(employerId);
      if (access.active) return res.json({ success: true, ...access });
      const config = createAppConfig();
      return res.status(402).json({
        success: true,
        ...access,
        banner: config.expiredBanner,
        action: 'renew',
        gumroadLinks: config.gumroadLinks
      });
    } catch (error) {
      console.error('Unable to load Gumroad access status:', error);
      return res.status(500).json({ success: false, message: 'Unable to load subscription status.' });
    }
  }

  return { createCheckout, verifyLicenseKey, handleWebhookEvent, getAccessStatus };
}

module.exports = { createGumroadController };
