const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
]);

function parseDmyy(value) {
  if (typeof value !== 'string' || !/^\d{2}\/\d{2}\/\d{2}$/.test(value)) {
    throw new Error('Dates must use DD/MM/YY format.');
  }
  const [day, month, shortYear] = value.split('/').map(Number);
  const year = shortYear >= 50 ? 1900 + shortYear : 2000 + shortYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Enter a valid calendar date.');
  }
  return date.toISOString().slice(0, 10);
}

function evaluateStateRules({ workState, employeeCount, offerAccepted, eVerifyRequested, eVerifyEnrolled, stateLawReviewConfirmed }) {
  const state = typeof workState === 'string' ? workState.toUpperCase() : '';
  if (!US_STATES.has(state)) throw new Error('Select a valid U.S. work state or district.');
  if (!Number.isSafeInteger(employeeCount) || employeeCount < 0) throw new Error('Enter a valid employer employee count.');

  const result = {
    state,
    mandatory: false,
    allowed: true,
    manualReviewRequired: !['CA', 'FL'].includes(state),
    requirements: [],
    errors: []
  };

  if (offerAccepted !== true) {
    result.errors.push('Do not collect Form I-9 information or conduct employment eligibility verification before the employee accepts an offer of employment.');
  }

  if (state === 'FL' && employeeCount >= 25) {
    result.mandatory = true;
    result.requirements.push('Florida private employers with 25 or more employees must use E-Verify for new hires.');
    if (eVerifyEnrolled !== true) result.errors.push('This Florida employer meets the 25-employee threshold and must be enrolled in E-Verify.');
    if (eVerifyRequested !== true) result.errors.push('An E-Verify case is required for this Florida new hire.');
  }

  if (state === 'CA' && eVerifyRequested === true && offerAccepted !== true) {
    result.errors.push('California also prohibits using E-Verify to prescreen applicants before an accepted offer.');
  }

  if (result.manualReviewRequired && stateLawReviewConfirmed !== true) {
    result.errors.push('Confirm that current state and local E-Verify requirements were reviewed for this work location.');
  }

  if (eVerifyRequested === true && eVerifyEnrolled !== true) {
    result.errors.push('The employer must be enrolled in E-Verify before requesting a case.');
  }

  result.allowed = result.errors.length === 0;
  return result;
}

function validateDocumentChoice({ listChoice, listAName, listBName, listCName, employeeSelectedDocuments }) {
  if (employeeSelectedDocuments !== true) throw new Error('The employee must choose which acceptable documents to present.');
  if (listChoice === 'A' && typeof listAName === 'string' && listAName.trim()) return true;
  if (listChoice === 'BC' && typeof listBName === 'string' && listBName.trim() && typeof listCName === 'string' && listCName.trim()) return true;
  throw new Error('Record either one employee-selected List A document or one employee-selected List B and one List C document.');
}

function validateRemoteProcedure({ remoteProcedure, eVerifyEnrolled, dhsProcedureEligible, liveVideoConfirmed, attachmentCount }) {
  if (remoteProcedure === true && (eVerifyEnrolled !== true || dhsProcedureEligible !== true || liveVideoConfirmed !== true || attachmentCount < 1)) {
    throw new Error('The DHS alternative procedure requires E-Verify participation in good standing, retained document copies, a live video examination, and uploaded document copies.');
  }
  if (liveVideoConfirmed === true && remoteProcedure !== true) {
    throw new Error('Confirm the DHS alternative procedure checkbox when recording a remote live-video examination.');
  }
  return true;
}

function getReverificationThresholds(daysRemaining) {
  if (!Number.isFinite(daysRemaining) || daysRemaining <= 0) return [];
  if (daysRemaining <= 30) return [30];
  return [90, 60, 30].filter((thresholdDays) => thresholdDays <= daysRemaining);
}

module.exports = { evaluateStateRules, getReverificationThresholds, parseDmyy, validateDocumentChoice, validateRemoteProcedure };