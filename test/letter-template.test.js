const test = require('node:test');
const assert = require('node:assert/strict');
const { createVerificationParagraphs } = require('../letter-template');
const { createPdfBuffer } = require('../letter-pdf');

const details = {
  employeeName: 'Alex Morgan',
  jobTitle: 'Operations Analyst',
  departmentName: 'Operations',
  startDate: '2024-03-01',
  workStatus: 'Full-Time',
  lifecycle: 'Current Employee',
  endDate: '2026-02-28',
  rehireEligibility: 'Eligible',
  baseSalary: '$72,000 annually',
  payFrequency: 'Annual',
  averageHours: '40',
  ytdEarnings: '$54,000',
  bonusAmount: '$5,000',
  overtimeEligibility: 'No',
  verificationPurpose: 'Residential Tenancy',
  representativeName: 'Jordan Lee',
  representativePhone: '555-0100',
  representativeEmail: 'jordan@example.com',
  documentId: 'EV-2026-0001'
};

test('generates the specified three paragraphs for a current employee verbatim', () => {
  assert.deepEqual(createVerificationParagraphs(details), [
    'This statement provides official employment verification for Alex Morgan. Alex Morgan holds the position of Operations Analyst within Operations, having commenced active service on 2024-03-01. Employment status is classified as Full-Time.',
    'Compensation records reflect a base pay rate of $72,000 annually paid on a Annual schedule, with average weekly hours recorded at 40. Year-to-date gross earnings stand at $54,000, with additional annual variable pay recorded at $5,000. Overtime eligibility is marked as No.',
    'This document is issued for Residential Tenancy purposes. Information provided reflects company records. For independent verification or administrative questions, contact Jordan Lee directly at 555-0100 or jordan@example.com. Verification Reference: EV-2026-0001.'
  ]);
});

test('includes the specified separation and rehire sentences for a former employee', () => {
  const [paragraphOne] = createVerificationParagraphs({
    ...details,
    lifecycle: 'Former Employee'
  });

  assert.equal(
    paragraphOne,
    'This statement provides official employment verification for Alex Morgan. Alex Morgan held the position of Operations Analyst within Operations, having commenced active service on 2024-03-01. Employment status is classified as Full-Time. Separation occurred on 2026-02-28. Rehire eligibility status is recorded as Eligible.'
  );
});

test('stamps digital initials on every generated PDF page', () => {
  const text = Array.from({ length: 100 }, (_, index) => `Employment record detail ${index + 1}`).join('\n');
  const pdf = createPdfBuffer(text, undefined, 'AB');
  const pdfText = pdf.toString('ascii');
  const pageCount = Number(pdfText.match(/\/Count (\d+)/)[1]);
  assert.ok(pageCount > 1);
  assert.equal((pdfText.match(/Digital initials: AB/g) || []).length, pageCount);
  assert.equal((pdfText.match(/us-evs\.com is an independent commercial software platform and is not affiliated/g) || []).length, pageCount);
  assert.equal((pdfText.match(/with any local, state, or federal government agency\./g) || []).length, pageCount);
});
