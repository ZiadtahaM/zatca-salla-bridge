import test from 'node:test';
import assert from 'node:assert/strict';
import { generateComplianceDocumentSet } from '../src/services/invoice-generator.js';
import { generateValidSecp256k1TestCert } from './helpers.js';
import { validateZatcaPreflight } from '../src/services/zatca-preflight.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Mandatory 6-Document Compliance Suite: Generates, Chained-Hashes, and Preflight-Validates All 6 Combinations', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'zatca-compliance-suite-test-'));

  try {
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(workDir);

    const docs = generateComplianceDocumentSet({
      sellerNameArabic: 'متجر الاختبار المعتمد للتقنية',
      sellerVat: '399999999900003',
      sellerCrn: '1010010000',
      privateKeyPem,
      certPem
    });

    // 1. Check exact count
    assert.strictEqual(docs.length, 6, 'Must generate exactly 6 compliance documents for 1100 EGS unit');

    // 2. Document types and sub-types
    const expectedDocs = [
      { name: 'Standard B2B Tax Invoice', typeCode: '388', subtype: '0100000', icv: 1, isB2B: true },
      { name: 'Standard B2B Credit Note', typeCode: '381', subtype: '0100000', icv: 2, isB2B: true },
      { name: 'Standard B2B Debit Note', typeCode: '383', subtype: '0100000', icv: 3, isB2B: true },
      { name: 'Simplified B2C Tax Invoice', typeCode: '388', subtype: '0200000', icv: 4, isB2B: false },
      { name: 'Simplified B2C Credit Note', typeCode: '381', subtype: '0200000', icv: 5, isB2B: false },
      { name: 'Simplified B2C Debit Note', typeCode: '383', subtype: '0200000', icv: 6, isB2B: false }
    ];

    let previousHash = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==';

    for (let i = 0; i < 6; i++) {
      const doc = docs[i];
      const expected = expectedDocs[i];

      assert.strictEqual(doc.name, expected.name);
      assert.strictEqual(doc.typeCode, expected.typeCode);
      assert.strictEqual(doc.subtype, expected.subtype);
      assert.strictEqual(doc.icv, expected.icv);
      assert.strictEqual(doc.isB2B, expected.isB2B);

      // Verify unbroken PIH chain
      assert.strictEqual(doc.pih, previousHash, `Document ${i + 1} PIH must exactly equal Document ${i}'s hash`);
      assert.match(doc.invoiceHash, /^[A-Za-z0-9+/=]{44}$/, `Document ${i + 1} invoice hash must be valid Base64 SHA-256`);

      // Verify UBL XML syntax contains mandatory ZATCA fields
      assert.ok(doc.signedXml.includes(`<cbc:InvoiceTypeCode name="${expected.subtype}">${expected.typeCode}</cbc:InvoiceTypeCode>`));
      assert.ok(doc.signedXml.includes(`<cbc:UUID>${doc.uuid}</cbc:UUID>`));
      assert.ok(doc.signedXml.includes(`<cbc:UUID>${doc.icv}</cbc:UUID>`));

      // Corrective documents (381, 383) must have BillingReference
      if (expected.typeCode === '381' || expected.typeCode === '383') {
        assert.ok(doc.signedXml.includes('<cac:BillingReference>'), `Corrective document ${expected.name} must contain BillingReference`);
        assert.ok(doc.signedXml.includes('<cbc:InstructionNote>'), `Corrective document ${expected.name} must contain reason InstructionNote`);
      }

      // Preflight schema validation
      const preflight = validateZatcaPreflight(doc.signedXml);
      assert.strictEqual(
        preflight.valid,
        true,
        `Document ${expected.name} must pass all local ZATCA preflight checks. Findings: ${JSON.stringify(preflight.findings)}`
      );

      previousHash = doc.invoiceHash;
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
});
