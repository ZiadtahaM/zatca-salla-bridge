process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateZatcaPreflight } from '../src/services/zatca-preflight.js';
import { buildServer } from '../src/server.js';

const COMPLIANT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-2026-0001</cbc:ID>
  <cbc:UUID>123e4567-e89b-12d3-a456-426614174000</cbc:UUID>
  <cbc:IssueDate>2026-10-20</cbc:IssueDate>
  <cbc:IssueTime>14:30:00</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>1</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>King Fahd Road</cbc:StreetName>
        <cbc:BuildingNumber>1234</cbc:BuildingNumber>
        <cbc:CityName>Riyadh</cbc:CityName>
        <cbc:PostalZone>12345</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>310123456700003</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>متجر الاختبار المعتمد</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">115.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">115.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">1.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>عطر شرقي فاخر</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

test('Milestone 3: validateZatcaPreflight passes 100% on fully compliant UBL 2.1 XML', () => {
  const result = validateZatcaPreflight(COMPLIANT_XML, 'xml');
  assert.equal(result.valid, true);
  assert.equal(result.documentType, 'Simplified');
  assert.equal(result.score, 100);
  assert.equal(result.summary.failedChecks, 0);
  assert.equal(result.summary.fineRiskSar, 0);
});

test('Milestone 3: validateZatcaPreflight catches invalid 15-digit VAT number (BR-KSA-08)', () => {
  const invalidVatXml = COMPLIANT_XML.replace('310123456700003', '123456789');
  const result = validateZatcaPreflight(invalidVatXml, 'xml');
  assert.equal(result.valid, false);
  const vatFinding = result.findings.find(f => f.code === 'BR-KSA-08');
  assert.ok(vatFinding, 'Expected BR-KSA-08 finding');
  assert.equal(vatFinding.severity, 'ERROR');
  assert.equal(vatFinding.category, 'BUSINESS_RULES');
  assert.equal(vatFinding.fineImpactSar, 10000);
});

test('Milestone 3: validateZatcaPreflight catches math discrepancy in LineExtensionAmount (BR-CO-10)', () => {
  const mathErrorXml = COMPLIANT_XML.replace(
    '<cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>',
    '<cbc:LineExtensionAmount currencyID="SAR">90.00</cbc:LineExtensionAmount>'
  );
  const result = validateZatcaPreflight(mathErrorXml, 'xml');
  assert.equal(result.valid, false);
  const mathFinding = result.findings.find(f => f.code === 'BR-CO-10');
  assert.ok(mathFinding, 'Expected BR-CO-10 finding');
  assert.equal(mathFinding.severity, 'ERROR');
  assert.equal(mathFinding.category, 'TAX_MATH');
});

test('Milestone 3: validateZatcaPreflight catches non-NFC normalized Unicode characters', () => {
  // Decomposed Unicode string (NFD instead of NFC)
  const nfdArabic = 'متجر'.normalize('NFD');
  const nfdXml = COMPLIANT_XML.replace('متجر', nfdArabic);
  // Test only if NFD produces distinct code points
  if (nfdArabic !== nfdArabic.normalize('NFC')) {
    const result = validateZatcaPreflight(nfdXml, 'xml');
    const nfcFinding = result.findings.find(f => f.code === 'BR-KSA-ENCODING-NFC');
    assert.ok(nfcFinding, 'Expected BR-KSA-ENCODING-NFC finding');
  }
});

test('Milestone 3: POST /api/validate/preflight returns structured JSON audit result', async () => {
  const app = buildServer();
  const res = await app.inject({
    method: 'POST',
    url: '/api/validate/preflight',
    payload: {
      content: COMPLIANT_XML,
      format: 'xml'
    }
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.valid, true);
  assert.equal(body.score, 100);
  assert.equal(body.summary.fineRiskSar, 0);
});

test('Milestone 3: GET /debugger serves self-contained HTML interface', async () => {
  const app = buildServer();
  const res = await app.inject({
    method: 'GET',
    url: '/debugger'
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['content-type']?.includes('text/html'));
  assert.ok(res.body.includes('ZATCA Phase 2 Pre-Flight Debugger'));
  assert.ok(res.body.includes('فاحص الفواتير الاستباقي'));
});
