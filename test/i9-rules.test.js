const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateStateRules, getReverificationThresholds, parseDmyy, validateDocumentChoice, validateRemoteProcedure } = require('../i9-rules');

test('parses strict DD/MM/YY calendar dates with a documented two-digit-year pivot', () => {
  assert.equal(parseDmyy('31/12/49'), '2049-12-31');
  assert.equal(parseDmyy('01/01/50'), '1950-01-01');
  assert.throws(() => parseDmyy('31/02/24'), /valid calendar date/);
  assert.throws(() => parseDmyy('2024-02-29'), /DD\/MM\/YY/);
});

test('Florida 25 employee rule requires enrollment and E-Verify case tracking', () => {
  const decision = evaluateStateRules({ workState: 'FL', employeeCount: 25, offerAccepted: true, eVerifyRequested: false, eVerifyEnrolled: false });
  assert.equal(decision.mandatory, true);
  assert.equal(decision.allowed, false);
  assert.equal(decision.errors.length, 2);
  assert.equal(evaluateStateRules({ workState: 'FL', employeeCount: 24, eVerifyRequested: false, eVerifyEnrolled: false }).mandatory, false);
});

test('California blocks pre-offer E-Verify and other jurisdictions request manual review', () => {
  assert.equal(evaluateStateRules({ workState: 'CA', employeeCount: 2, eVerifyRequested: true, eVerifyEnrolled: true, offerAccepted: false }).allowed, false);
  assert.equal(evaluateStateRules({ workState: 'CA', employeeCount: 2, eVerifyRequested: true, eVerifyEnrolled: true, offerAccepted: true }).allowed, true);
  assert.equal(evaluateStateRules({ workState: 'NY', employeeCount: 2, eVerifyRequested: false, eVerifyEnrolled: false, offerAccepted: true }).manualReviewRequired, true);
  assert.equal(evaluateStateRules({ workState: 'NY', employeeCount: 2, eVerifyRequested: false, eVerifyEnrolled: false, offerAccepted: false }).allowed, false);
});

test('document choice allows List A or List B plus List C only when employee chose', () => {
  assert.equal(validateDocumentChoice({ listChoice: 'A', listAName: 'U.S. Passport', employeeSelectedDocuments: true }), true);
  assert.equal(validateDocumentChoice({ listChoice: 'BC', listBName: 'Driver license', listCName: 'Social Security card', employeeSelectedDocuments: true }), true);
  assert.throws(() => validateDocumentChoice({ listChoice: 'A', listAName: 'Passport', employeeSelectedDocuments: false }), /employee must choose/);
  assert.throws(() => validateDocumentChoice({ listChoice: 'B', listBName: 'Driver license', employeeSelectedDocuments: true }), /either one/);
});

test('remote examination requires E-Verify standing, copies, and a live video check', () => {
  assert.equal(validateRemoteProcedure({
    remoteProcedure: true,
    eVerifyEnrolled: true,
    dhsProcedureEligible: true,
    liveVideoConfirmed: true,
    attachmentCount: 2
  }), true);
  assert.throws(() => validateRemoteProcedure({ remoteProcedure: true, eVerifyEnrolled: true, attachmentCount: 0 }), /live video examination/);
});

test('reverification reminders select future milestones without sending stale notice bursts', () => {
  assert.deepEqual(getReverificationThresholds(120), [90, 60, 30]);
  assert.deepEqual(getReverificationThresholds(75), [60, 30]);
  assert.deepEqual(getReverificationThresholds(20), [30]);
  assert.deepEqual(getReverificationThresholds(-1), []);
});