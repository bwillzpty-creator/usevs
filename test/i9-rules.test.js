const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateStateRules, getReverificationThresholds, parseUsDate, validateDocumentChoice, validateRemoteProcedure } = require('../i9-rules');

test('parses strict MM/DD/YYYY calendar dates', () => {
  assert.equal(parseUsDate('12/31/2049'), '2049-12-31');
  assert.equal(parseUsDate('01/01/1950'), '1950-01-01');
  assert.equal(parseUsDate('02/29/2024'), '2024-02-29');
  assert.throws(() => parseUsDate('02/30/2024'), /valid calendar date/);
  assert.throws(() => parseUsDate('13/01/2024'), /valid calendar date/);
  assert.throws(() => parseUsDate('2024-02-29'), /MM\/DD\/YYYY/);
  assert.throws(() => parseUsDate('12/31/49'), /MM\/DD\/YYYY/);
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