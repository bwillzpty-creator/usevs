(function registerLetterTemplate(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LetterTemplate = api;
  }
})(globalThis, function createLetterTemplateApi() {
  function createVerificationParagraphs(details) {
    const former = details.lifecycle === "Former Employee";
    return [
      `This statement provides official employment verification for ${details.employeeName}. ${details.employeeName} ${former ? "held" : "holds"} the position of ${details.jobTitle} within ${details.departmentName}, having commenced active service on ${details.startDate}. Employment status is classified as ${details.workStatus}.${former ? ` Separation occurred on ${details.endDate}. Rehire eligibility status is recorded as ${details.rehireEligibility}.` : ""}`,
      `Compensation records reflect a base pay rate of ${details.baseSalary} paid on a ${details.payFrequency} schedule, with average weekly hours recorded at ${details.averageHours}. Year-to-date gross earnings stand at ${details.ytdEarnings}, with additional annual variable pay recorded at ${details.bonusAmount}. Overtime eligibility is marked as ${details.overtimeEligibility}.`,
      `This document is issued for ${details.verificationPurpose} purposes. Information provided reflects company records. For independent verification or administrative questions, contact ${details.representativeName} directly at ${details.representativePhone} or ${details.representativeEmail}. Verification Reference: ${details.documentId}.`
    ];
  }

  return { createVerificationParagraphs };
});
