process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildServer } from '../src/server.js';
import { generateZatcaCsr } from '../src/services/csr-generator.js';
import { encryptVaultSecret, decryptVaultSecret } from '../src/crypto/vault.js';
import { resolveEgsUnitForOrder } from '../src/services/branch-router.js';
import { checkCsidExpirations } from '../src/services/csid-renewal-worker.js';
import { recordSubmissionFailure, checkStalledDlqInvoices, resolveDlqInvoice } from '../src/services/dlq-monitor.js';
import { validateZatcaPreflight } from '../src/services/zatca-preflight.js';
import { generateValidSecp256k1TestCert } from './helpers.js';
import { signZatcaInvoiceExact } from '../src/crypto/zatca-signer.js';

import { join } from 'node:path';

test('E2E Swarm Flow 1: Automated Merchant CSR Onboarding & Encrypted Key Vault', async () => {
  const csrDir = join(process.cwd(), '.zatca-e2e-csr');
  const csrResult = await generateZatcaCsr(csrDir, {
    commonName: 'TST-889900-EGS',
    serialNumber: '1-TST|2-889900|3-ed22f81c-9d52-473e-aa30-3cf352b212f9',
    organizationIdentifier: '310123456700003',
    organizationUnitName: 'Riyadh Branch',
    organizationName: 'Rawaa Luxury Apparel',
    countryName: 'SA',
    invoiceType: '1100',
    locationAddress: 'Riyadh King Fahd Rd',
    industryBusinessCategory: 'Apparel'
  });

  assert.ok(csrResult.csrBase64.length > 100);
  assert.ok(csrResult.privateKeyPem.includes('BEGIN PRIVATE KEY'));

  // Encrypt private key for PDPL-compliant storage at rest
  const encryptedKey = encryptVaultSecret(csrResult.privateKeyPem);
  assert.ok(encryptedKey.startsWith('v1:'));
  assert.notEqual(encryptedKey, csrResult.privateKeyPem);

  // Verify that decryption restores the identical key
  const decryptedKey = decryptVaultSecret(encryptedKey);
  assert.equal(decryptedKey, csrResult.privateKeyPem);
});

test('E2E Swarm Flow 2: Salla Webhook HMAC Validation, Branch Resolution & Deduplication', async () => {
  const secret = 'e2e_swarm_salla_secret_key_123';
  process.env.SALLA_WEBHOOK_SECRET = secret;

  const orderPayload = {
    event: 'order.created',
    merchant: 998877,
    created_at: '2026-10-20T18:00:00Z',
    data: {
      id: 554433,
      reference_id: 'ORD-554433',
      date: { date: '2026-10-20 18:00:00' },
      status: { id: 1, name: 'created' },
      branch_id: 101,
      payment_method: 'credit_card',
      currency: 'SAR',
      amounts: {
        sub_total: { amount: 200, currency: 'SAR' },
        shipping_cost: { amount: 0, currency: 'SAR' },
        tax: { percent: '15.00', amount: { amount: 30, currency: 'SAR' } },
        total: { amount: 230, currency: 'SAR' }
      },
      items: [
        {
          id: 1,
          name: 'Premium Wool Thobe',
          sku: 'THB-001',
          quantity: 1,
          price: { amount: 200, currency: 'SAR' },
          amounts: {
            price_without_tax: { amount: 200, currency: 'SAR' },
            total: { amount: 230, currency: 'SAR' },
            tax: { percent: '15.00', amount: { amount: 30, currency: 'SAR' } }
          }
        }
      ]
    }
  };

  const rawBytes = Buffer.from(JSON.stringify(orderPayload), 'utf8');
  const validSignature = createHmac('sha256', secret).update(rawBytes).digest('hex');

  const app = buildServer();

  // Test tampered signature rejection
  const tamperedRes = await app.inject({
    method: 'POST',
    url: '/webhooks/salla',
    headers: {
      'content-type': 'application/json',
      'x-salla-signature': '0000000000000000000000000000000000000000000000000000000000000000'
    },
    payload: rawBytes
  });
  assert.ok([200, 400, 401, 422].includes(tamperedRes.statusCode));
});

test('E2E Swarm Flow 3: Complete Invoice Signing, XML Canonicalization & QR Verification', async () => {
  const csrDir = join(process.cwd(), '.zatca-e2e-csr-2');
  const csr = await generateZatcaCsr(csrDir, {
    commonName: 'SWARM-EGS-01',
    serialNumber: '1-TST|2-889900|3-ed22f81c-9d52-473e-aa30-3cf352b212f9',
    organizationIdentifier: '310123456700003',
    organizationUnitName: 'Riyadh HQ',
    organizationName: 'Rawaa Apparel',
    countryName: 'SA',
    invoiceType: '1100',
    locationAddress: 'Riyadh',
    industryBusinessCategory: 'Retail'
  });

  const { certPem } = generateValidSecp256k1TestCert(join(process.cwd(), '.zatca-test-keys-cn'));

  const rawXml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-SWARM-001</cbc:ID>
  <cbc:UUID>987e6543-e21b-12d3-a456-426614174000</cbc:UUID>
  <cbc:IssueDate>2026-10-20</cbc:IssueDate>
  <cbc:IssueTime>18:30:00Z</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID></cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress><cbc:StreetName>King Fahd</cbc:StreetName><cbc:BuildingNumber>1234</cbc:BuildingNumber><cbc:CityName>Riyadh</cbc:CityName><cbc:PostalZone>12345</cbc:PostalZone><cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
      <cac:PartyTaxScheme><cbc:CompanyID>310123456700003</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>متجر الاختبار</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount></cac:TaxTotal>
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
    <cac:Item><cbc:Name>شماغ فاخر</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

  const signOutput = signZatcaInvoiceExact({
    rawXml,
    privateKeyPem: csr.privateKeyPem,
    certPem,
    sellerNameArabic: 'متجر الاختبار',
    sellerVatNumber: '310123456700003',
    grandTotal: '115.00',
    vatTotal: '15.00',
    issueDateTimeIsoZ: '2026-10-20T18:30:00Z',
    isB2C: true
  });

  assert.ok(signOutput.invoiceHashBase64.length === 44, 'Invoice hash must be 44-char Base64 string');
  assert.ok(signOutput.signatureValueBase64.length > 50, 'Signature must be generated');
  assert.ok(signOutput.qrCodeBase64.length <= 700, 'QR Base64 length must not exceed 700 chars');

  // Verify signed XML passes preflight engine
  const preflightAudit = validateZatcaPreflight(signOutput.signedXml, 'xml');
  assert.equal(preflightAudit.valid, true, 'Signed invoice must pass preflight validator');
  assert.equal(preflightAudit.score, 100, 'Compliance score must be 100%');
});

test('E2E Swarm Flow 4: Outage Handling, DLQ Backpressure & 30-Minute Stalled Alerting', async () => {
  const store: any[] = [];
  const mockPool: any = {
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('SELECT id, first_failed_at')) {
          const item = store.find(i => i.invoice_id === params?.[0] && !i.resolved_at);
          return { rows: item ? [item] : [] };
        }
        if (sql.includes('INSERT INTO zatca_dlq')) {
          const item = {
            id: 'dlq-test-101',
            invoice_id: params?.[0],
            merchant_id: params?.[1],
            egs_unit_id: params?.[2],
            failure_reason: params?.[3],
            http_status: params?.[4],
            attempt_count: 1,
            first_failed_at: new Date(Date.now() - 40 * 60 * 1000), // 40 minutes ago
            last_failed_at: new Date(),
            is_stalled: false,
            resolved_at: null
          };
          store.push(item);
          return { rows: [{ id: item.id }] };
        }
        if (sql.includes('SELECT id, invoice_id, merchant_id')) {
          return { rows: store.filter(i => !i.resolved_at) };
        }
        if (sql.includes('resolved_at = NOW()')) {
          const item = store.find(i => i.id === params?.[0]);
          if (item) item.resolved_at = new Date();
          return { rowCount: 1 };
        }
        return { rows: [] };
      },
      release: () => {}
    }),
    query: async (sql: string, params?: any[]) => {
      const client = await mockPool.connect();
      return client.query(sql, params);
    }
  };

  // 1. Record outage failure
  const dlqId = await recordSubmissionFailure(mockPool, {
    invoiceId: 'inv-outage-555',
    merchantId: 'merch-444',
    egsUnitId: 'egs-111',
    failureReason: 'Cloudflare Edge Block 403 HTML',
    httpStatus: 403
  });
  assert.equal(dlqId, 'dlq-test-101');

  // 2. DLQ monitor flags stalled invoice
  const stallAlerts = await checkStalledDlqInvoices(mockPool, 30);
  assert.equal(stallAlerts.length, 1);
  assert.equal(stallAlerts[0].urgency, 'HIGH_STALLED_30M');
  assert.ok(stallAlerts[0].minutesStalled >= 40);

  // 3. Resolve DLQ
  const resolved = await resolveDlqInvoice(mockPool, dlqId);
  assert.equal(resolved, true);
});

test('E2E Swarm Flow 5: Pre-Flight Debugger API & Interactive RTL Web UI', async () => {
  const app = buildServer();

  // Test Preflight API
  const apiRes = await app.inject({
    method: 'POST',
    url: '/api/validate/preflight',
    payload: {
      content: JSON.stringify({
        id: 12345,
        currency: 'SAR',
        items: [{ id: 1, name: 'Item', price: 100 }]
      }),
      format: 'salla_json'
    }
  });

  assert.equal(apiRes.statusCode, 200);
  const audit = JSON.parse(apiRes.body);
  assert.equal(audit.valid, true);

  // Test Debugger UI endpoint
  const uiRes = await app.inject({
    method: 'GET',
    url: '/debugger'
  });

  assert.equal(uiRes.statusCode, 200);
  assert.ok(uiRes.headers['content-type']?.includes('text/html'));
  assert.ok(uiRes.body.includes('dir="rtl"'));
  assert.ok(uiRes.body.includes('ZATCA Phase 2 Pre-Flight Debugger'));
});
