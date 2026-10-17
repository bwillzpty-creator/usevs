const express = require('express');
const { createGumroadController } = require('../controllers/gumroad.controller');

function createGumroadRouter({ service, requireEmployer } = {}) {
  if (typeof requireEmployer !== 'function') {
    throw new Error('An employer-session middleware is required for Gumroad API routes.');
  }
  const controller = createGumroadController({ service });
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));

  router.post('/checkout', requireEmployer, controller.createCheckout);
  router.post('/verify-license', requireEmployer, controller.verifyLicenseKey);
  router.post('/webhook', controller.handleWebhookEvent);
  router.get('/access', requireEmployer, controller.getAccessStatus);
  return router;
}

module.exports = { createGumroadRouter };
