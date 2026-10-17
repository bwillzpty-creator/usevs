const { createAppConfig } = require('../app.config');

function createSubscriptionMiddleware({ service, getUsageCount, config = createAppConfig(), logger = console } = {}) {
  if (!service) throw new Error('Gumroad service is required.');

  function employerIdFromRequest(req) {
    return req.issuerContext?.employer?.id || req.employer?.id || req.auth?.employerId || null;
  }

  function expiredResponse(res, status = 402) {
    return res.status(status).json({
      banner: config.expiredBanner,
      action: 'renew'
    });
  }

  function requireActiveGumroadPlan(getEmployerId = employerIdFromRequest) {
    return async (req, res, next) => {
      const employerId = typeof getEmployerId === 'function' ? getEmployerId(req) : getEmployerId;
      if (!employerId) return res.status(401).json({ success: false, message: 'Authenticated employer context is missing.' });
      let access;
      try {
        access = await service.getAccessStatus(employerId);
      } catch (error) {
        logger.error('Unable to enforce Gumroad access:', error);
        return res.status(503).json({ success: false, message: 'Unable to verify subscription access.' });
      }
      if (!access.active) return expiredResponse(res);
      req.gumroadAccess = access;
      return next();
    };
  }

  function enforcePlanLimit(resource, getCount = getUsageCount) {
    if (!['employees', 'letters'].includes(resource)) throw new Error('Plan limit resource must be employees or letters.');
    if (typeof getCount !== 'function') throw new Error('A usage-count resolver is required for plan limit enforcement.');
    return async (req, res, next) => {
      const employerId = employerIdFromRequest(req);
      if (!employerId) return res.status(401).json({ success: false, message: 'Authenticated employer context is missing.' });
      try {
        const access = req.gumroadAccess || await service.getAccessStatus(employerId);
        if (!access.active) return expiredResponse(res);
        const limit = access.limits?.[resource === 'employees' ? 'maxEmployees' : 'maxLetters'];
        if (limit !== null && limit !== undefined) {
          const currentCount = await getCount(employerId, resource, req);
          if (!Number.isFinite(currentCount) || currentCount < 0) throw new Error('Usage-count resolver returned an invalid count.');
          if (currentCount >= limit) {
            await service.trackEvent('gumroad_limit_hit', employerId, {
              resource,
              planCode: access.planCode,
              limit,
              currentCount
            });
            const label = resource === 'employees' ? 'employee' : 'letter';
            return res.status(402).json({
              action: 'renew',
              gumroadLinks: config.gumroadLinks,
              message: `Your ${access.planCode} plan allows ${limit} ${label}${limit === 1 ? '' : 's'}.`
            });
          }
        }
        req.gumroadAccess = access;
      } catch (error) {
        logger.error('Unable to enforce Gumroad plan limits:', error);
        return res.status(503).json({ success: false, message: 'Unable to verify subscription limits.' });
      }
      return next();
    };
  }

  function allowHistoryReadOnly(req, res, next) {
    req.gumroadHistoryViewOnly = true;
    return next();
  }

  return { allowHistoryReadOnly, enforcePlanLimit, requireActiveGumroadPlan };
}

module.exports = { createSubscriptionMiddleware };
