process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  buildUblXmlFromSallaOrder,
  validateB2bBuyerAddress,
  isExportCustomer,
  resubmitCorrectedZatcaInvoice,
  remedyRejectedSimplifiedInvoice,
  resubmitSimplifiedInvoiceForReporting,
  processSallaOrderIntoZatcaInvoice
} from '../src/services/invoice-generator.js';
import { processSallaWebhookPayload } from '../src/routes/salla-webhook.js';
import { validateZatcaPreflight } from '../src/services/zatca-preflight.js';
import { SallaOrderData } from '../src/types/salla.js';
import { attachStatefulRelationalTestDb, generateValidSecp256k1TestCert } from './helpers.js';
import { encryptVaultSecret } from '../src/crypto/vault.js';
import { Pool } from 'pg';

function createBaseMockOrder(): SallaOrderData {
  return {
    id: 991001,
    reference_id: 'REF-991001',
    date: {
      date: '2026-10-21 14:00:00',
      timezone: 'Asia/Riyadh'
    },
    status: {
      id: 1,
      name: 'مكتمل',
      slug: 'completed'
    },
    currency: 'SAR',
    customer: {
      id: 501,
      first_name: 'عبدالله',
      last_name: 'القحطاني',
      mobile: '+966501234567',
      email: 'abdullah@example.com'
    },
    items: [
      {
        id: 101,
        name: 'طقم ملابس فاخر',
        sku: 'LUX-SET-01',
        quantity: 1,
        price: {
          amount: 200.0,
          currency: 'SAR'
        },
        amounts: {
          price_without_tax: { amount: 200.0, currency: 'SAR' },
          total_discount: { amount: 0, currency: 'SAR' }
        }
      }
    ],
    amounts: {
      sub_total: { amount: 200.0, currency: 'SAR' },
      shipping_cost: { amount: 0.0, currency: 'SAR' },
      cash_on_delivery: { amount: 0.0, currency: 'SAR' },
      tax: {
        percent: '15.00',
        amount: { amount: 30.0, currency: 'SAR' }
      },
      discounts: { amount: 0.0, currency: 'SAR' },
      total: { amount: 230.0, currency: 'SAR' }
    },
    shipping: {
      address: {
        country: 'Saudi Arabia',
        country_code: 'SA',
        city: 'Riyadh',
        district: 'Al-Olaya',
        street: 'King Fahd Road',
        building_number: '1234',
        postal_code: '12211'
      }
    }
  };
}

test('Discourse Edge Case 1: Foreign Currency Orders (USD) with SAR TaxTotal Conversion (BR-KSA-25)', () => {
  const order = createBaseMockOrder();
  order.currency = 'USD';
  order.amounts.sub_total.amount = 100.0;
  order.amounts.tax.amount.amount = 15.0;
  order.amounts.total.amount = 115.0;
  order.items[0].price.amount = 100.0;
  order.items[0].price.currency = 'USD';

  // Build UBL XML with USD currency and official 3.75 exchange rate
  const xml = buildUblXmlFromSallaOrder({
    order,
    uuid: '11111111-2222-3333-4444-555555555555',
    icv: 42,
    pih: 'NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=',
    issueDate: '2026-10-21',
    issueTime: '12:00:00Z',
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: true,
    currency: 'USD',
    exchangeRateToSar: 3.75
  });

  // Verify DocumentCurrencyCode is USD and TaxCurrencyCode remains SAR
  assert.ok(xml.includes('<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>'));
  assert.ok(xml.includes('<cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>'));

  // Verify root TaxTotal has TaxAmount in SAR (15 * 3.75 = 56.25 SAR)
  assert.ok(xml.includes('<cbc:TaxAmount currencyID="SAR">56.25</cbc:TaxAmount>'));

  // Run preflight validation
  const preflight = validateZatcaPreflight(xml, 'xml');
  assert.equal(preflight.valid, true, 'Preflight must accept valid foreign currency order with SAR TaxTotal');
  const currencyFinding = preflight.findings.find(f => f.code === 'BR-KSA-25-DOC-CURRENCY');
  assert.equal(currencyFinding, undefined, 'Must not report BR-KSA-25 error for recognized USD currency');
});

test('Discourse Edge Case 2: Non-Saudi / GCC Customers (BR-KSA-F-08 Export & Foreign Buyer ID)', () => {
  const order = createBaseMockOrder();
  order.shipping = {
    address: {
      country: 'United Arab Emirates',
      country_code: 'AE',
      city: 'Dubai',
      district: 'Downtown',
      street: 'Sheikh Zayed Road',
      building_number: '',
      postal_code: ''
    }
  };
  order.customer.company_name = 'Al-Futtaim Enterprise';
  order.customer.tax_number = 'AE-TRN-998877';

  // Address validation handles foreign buyer without Saudi 4-digit building number
  assert.equal(isExportCustomer('AE'), true);
  const validation = validateB2bBuyerAddress(order);
  assert.equal(validation.isValid, true, 'Export B2B buyer without 4-digit building number must be valid');

  const xml = buildUblXmlFromSallaOrder({
    order,
    uuid: '22222222-3333-4444-5555-666666666666',
    icv: 43,
    pih: 'NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=',
    issueDate: '2026-10-21',
    issueTime: '12:00:00Z',
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: false,
    isExport: true,
    foreignBuyerCountry: 'AE',
    foreignBuyerId: 'AE-TRN-998877',
    foreignBuyerScheme: 'OTH'
  });

  // Verify foreign buyer ID scheme is OTH
  assert.ok(xml.includes('<cbc:ID schemeID="OTH">AE-TRN-998877</cbc:ID>'));
  // Verify country code is AE
  assert.ok(xml.includes('<cbc:IdentificationCode>AE</cbc:IdentificationCode>'));
  // Verify export zero-rated tax category and exemption reason
  assert.ok(xml.includes('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">Z</cbc:ID>'));
  assert.ok(xml.includes('<cbc:TaxExemptionReasonCode>VATEX-SA-32</cbc:TaxExemptionReasonCode>'));

  const preflight = validateZatcaPreflight(xml, 'xml');
  assert.equal(preflight.valid, true, 'Export invoice must pass preflight with OTH ID and zero-rated VAT');
  const exportFinding = preflight.findings.find(f => f.code === 'BR-KSA-F-08');
  assert.equal(exportFinding, undefined, 'Must not report BR-KSA-F-08 finding for valid export buyer');
});

test('Discourse Edge Case 3: Selling Gift Cards & Multi-Purpose Vouchers (Category O & VATEX-SA-OOS)', () => {
  const order = createBaseMockOrder();
  order.items = [
    {
      id: 881,
      name: 'كوبون مشتريات هدية متعدد الأغراض 500 ريال',
      sku: 'VOUCHER-MPV-500',
      quantity: 1,
      price: { amount: 500.0, currency: 'SAR' },
      amounts: {
        price_without_tax: { amount: 500.0, currency: 'SAR' },
        total_discount: { amount: 0, currency: 'SAR' }
      }
    }
  ];
  order.amounts.sub_total.amount = 500.0;
  order.amounts.tax.amount.amount = 0.0;
  order.amounts.total.amount = 500.0;

  const xml = buildUblXmlFromSallaOrder({
    order,
    uuid: '33333333-4444-5555-6666-777777777777',
    icv: 44,
    pih: 'NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=',
    issueDate: '2026-10-21',
    issueTime: '12:00:00Z',
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: true
  });

  // Verify Out of Scope tax category O and reason code VATEX-SA-OOS
  assert.ok(xml.includes('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">O</cbc:ID>'));
  assert.ok(xml.includes('<cbc:TaxExemptionReasonCode>VATEX-SA-OOS</cbc:TaxExemptionReasonCode>'));
  assert.ok(xml.includes('<cbc:Percent>0.00</cbc:Percent>'));
  assert.ok(xml.includes('<cbc:TaxAmount currencyID="SAR">0.00</cbc:TaxAmount>'));

  const preflight = validateZatcaPreflight(xml, 'xml');
  assert.equal(preflight.valid, true, 'Voucher invoice with Category O must pass preflight');
});

test('Discourse Edge Case 4: B2B Down Payments & Prepayment Deduction (386 & BR-CO-16 & KSA-31..34)', () => {
  const order = createBaseMockOrder();
  order.customer.tax_number = '300075588700003';
  order.customer.company_name = 'مؤسسة الرياض للتوريدات';
  order.amounts.sub_total.amount = 1000.0;
  order.amounts.tax.amount.amount = 150.0;
  order.amounts.total.amount = 1150.0;
  order.items[0].price.amount = 1000.0;

  // Final invoice deducting 575 SAR advance deposit (500 taxable + 75 VAT)
  const xml = buildUblXmlFromSallaOrder({
    order,
    uuid: '44444444-5555-6666-7777-888888888888',
    icv: 45,
    pih: 'NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=',
    issueDate: '2026-10-21',
    issueTime: '12:00:00Z',
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: false,
    prepaymentAdjustments: [
      {
        invoiceId: 'ADV-INV-2026-001',
        invoiceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        issueDate: '2026-10-01',
        issueTime: '10:00:00Z',
        taxableAmount: 500.00,
        taxAmount: 75.00,
        vatCategory: 'S',
        vatRate: 15.00
      }
    ]
  });

  // Verify PrepaidAmount is 575.00 and PayableAmount is 575.00 (1150 - 575) per BR-CO-16
  assert.ok(xml.includes('<cbc:PrepaidAmount currencyID="SAR">575.00</cbc:PrepaidAmount>'), 'Must output exact PrepaidAmount (BT-113)');
  assert.ok(xml.includes('<cbc:PayableAmount currencyID="SAR">575.00</cbc:PayableAmount>'), 'Must satisfy BR-CO-16 PayableAmount');

  // Verify 386 Prepayment reference in AdditionalDocumentReference
  assert.ok(xml.includes('<cbc:ID>ADV-INV-2026-001</cbc:ID>'), 'Must cite prepayment invoice identifier (BT-1)');
  assert.ok(xml.includes('<cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>'), 'Must cite document type code 386 (KSA-30)');
  assert.ok(xml.includes('<cbc:IssueDate>2026-10-01</cbc:IssueDate>'), 'Must cite prepayment issue date (BT-2)');
  assert.ok(xml.includes('<cbc:IssueTime>10:00:00Z</cbc:IssueTime>'), 'Must cite prepayment issue time (KSA-25)');

  // Verify KSA-31, KSA-32, KSA-33, KSA-34 in UBLPrepaymentExtension
  assert.ok(xml.includes('<KSA-31 currencyID="SAR">500.00</KSA-31>'), 'Must contain KSA-31 taxable amount');
  assert.ok(xml.includes('<KSA-32 currencyID="SAR">75.00</KSA-32>'), 'Must contain KSA-32 tax amount');
  assert.ok(xml.includes('<KSA-33>S</KSA-33>'), 'Must contain KSA-33 VAT category');
  assert.ok(xml.includes('<KSA-34>15.00</KSA-34>'), 'Must contain KSA-34 VAT rate');

  const preflight = validateZatcaPreflight(xml, 'xml');
  assert.equal(preflight.valid, true, 'Prepaid deduction must satisfy BR-CO-16 math');
});

test('Discourse Edge Case 5: 24-Hour Late Reporting Warning Detection ([BR-KSA-98])', () => {
  const order = createBaseMockOrder();
  const oldIssueDate = '2026-09-01'; // 50 days ago
  const xml = buildUblXmlFromSallaOrder({
    order,
    uuid: '55555555-6666-7777-8888-999999999999',
    icv: 46,
    pih: 'NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=',
    issueDate: oldIssueDate,
    issueTime: '10:00:00Z',
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: true
  });

  const preflight = validateZatcaPreflight(xml, 'xml', {
    checkLateReporting: true,
    referenceTimestamp: new Date('2026-10-21T14:00:00Z')
  });

  const lateFinding = preflight.findings.find(f => f.code === 'BR-KSA-98');
  assert.ok(lateFinding, 'Must detect BR-KSA-98 late reporting warning for >24h old simplified invoice');
  assert.equal(lateFinding.severity, 'WARNING');
  assert.ok(lateFinding.messageEn.includes('24 hours'));
});

test('Discourse Edge Case 6: Multiple Prepayments and Multi-Category VAT Breakdown (BR-KSA-80)', () => {
  const order = createBaseMockOrder();
  order.customer.tax_number = '300075588700003';
  order.customer.company_name = 'مؤسسة التوريدات المتقدمة';
  order.amounts.sub_total.amount = 2000.0;
  order.amounts.tax.amount.amount = 300.0;
  order.amounts.total.amount = 2300.0;
  order.items[0].price.amount = 2000.0;

  // Prepayment 1: Standard 15% (300 SAR taxable, 45 SAR VAT = 345 SAR inclusive)
  // Prepayment 2: Historical 5% or Zero-rated (500 SAR taxable, 0 SAR VAT = 500 SAR inclusive)
  const xml = buildUblXmlFromSallaOrder({
    order,
    uuid: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
    icv: 52,
    pih: 'NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=',
    issueDate: '2026-10-22',
    issueTime: '11:00:00Z',
    sellerNameArabic: 'شركة رواء للملابس الفاخرة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: false,
    prepaymentAdjustments: [
      {
        invoiceId: 'ADV-01-STD',
        issueDate: '2026-10-01',
        issueTime: '09:00:00Z',
        taxableAmount: 300.00,
        taxAmount: 45.00,
        vatCategory: 'S',
        vatRate: 15.00
      },
      {
        invoiceId: 'ADV-02-ZERO',
        issueDate: '2026-10-10',
        issueTime: '14:00:00Z',
        taxableAmount: 500.00,
        taxAmount: 0.00,
        vatCategory: 'Z',
        vatRate: 0.00
      }
    ]
  });

  // Total prepaid = 345 + 500 = 845.00 SAR
  // Payable amount = 2300 - 845 = 1455.00 SAR
  assert.ok(xml.includes('<cbc:PrepaidAmount currencyID="SAR">845.00</cbc:PrepaidAmount>'), 'PrepaidAmount must equal sum of all prepayment lines');
  assert.ok(xml.includes('<cbc:PayableAmount currencyID="SAR">1455.00</cbc:PayableAmount>'), 'PayableAmount must satisfy BR-CO-16');

  // Verify both prepayment document references are present
  assert.ok(xml.includes('<cbc:ID>ADV-01-STD</cbc:ID>'));
  assert.ok(xml.includes('<cbc:ID>ADV-02-ZERO</cbc:ID>'));

  // Verify category breakdowns in XML
  assert.ok(xml.includes('<KSA-31 currencyID="SAR">300.00</KSA-31>'));
  assert.ok(xml.includes('<KSA-32 currencyID="SAR">45.00</KSA-32>'));
  assert.ok(xml.includes('<KSA-33>S</KSA-33>'));

  assert.ok(xml.includes('<KSA-31 currencyID="SAR">500.00</KSA-31>'));
  assert.ok(xml.includes('<KSA-32 currencyID="SAR">0.00</KSA-32>'));
  assert.ok(xml.includes('<KSA-33>Z</KSA-33>'));
  assert.ok(xml.includes('<KSA-34>0.00</KSA-34>'));

  const preflight = validateZatcaPreflight(xml, 'xml');
  assert.equal(preflight.valid, true, 'Multi-category prepayments must satisfy preflight math');
});

test('Discourse Edge Case 7: Rejected-Document Recovery: Immutable History & Hash Chain Continuity', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase7');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_reject');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_demo_store', 'متجر سلة التجريبي', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET
        store_name = EXCLUDED.store_name,
        vat_number = EXCLUDED.vat_number,
        crn = EXCLUDED.crn`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_demo_store', 'riyadh_hq', 'live_prod_test_unit', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 10, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==',
        '\\x00'::bytea, '\\x00'::bytea, 'dummy_hash', '11111111-2222-3333-4444-555555555555', 'SallaBridge-V1'
      ) ON CONFLICT (merchant_id, branch_id, custom_id) DO UPDATE SET updated_at = NOW() RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    const order = createBaseMockOrder();
    order.id = 99201;

    // Step 1: Initial document generation (Invoice 1)
    const doc1 = await processSallaOrderIntoZatcaInvoice(client, egsId, order, 'idemp_reject_01');
    assert.equal(doc1.icv, 11, 'Initial document must have ICV 11');
    const hash1 = doc1.invoiceHash;

    // Simulate ZATCA clearance rejection on Invoice 1 (HTTP 400 rejection)
    await client.query(
      `UPDATE invoices SET status = 'rejected' WHERE id = $1`,
      [doc1.invoiceId]
    );

    // Step 2: Verify rejected invoice remains immutable in database
    const rejectedCheck = await client.query(`SELECT status, icv, invoice_hash FROM invoices WHERE id = $1`, [doc1.invoiceId]);
    assert.equal(rejectedCheck.rows[0].status, 'rejected', 'Rejected document must preserve status');
    assert.equal(rejectedCheck.rows[0].icv, 11, 'Rejected document must preserve original ICV');
    assert.equal(rejectedCheck.rows[0].invoice_hash, hash1, 'Rejected document must preserve original hash');

    // Step 2b: Issue an Intervening Document (Invoice B) before correcting Invoice 1
    // This specifically tests the ZATCA invariant: PIH must reference the immediately preceding
    // document emitted by this EGS unit, NOT unconditionally the rejected document.
    const interveningOrder = createBaseMockOrder();
    interveningOrder.id = 99250;
    const docIntervening = await processSallaOrderIntoZatcaInvoice(client, egsId, interveningOrder, 'idemp_intervening_01');
    assert.equal(docIntervening.icv, 12, 'Intervening document must have ICV 12');
    assert.equal(docIntervening.pih, hash1, 'Intervening document PIH must reference rejected document hash');

    // Step 3: Resubmit corrected transaction via resubmitCorrectedZatcaInvoice
    const correctedOrder = createBaseMockOrder();
    correctedOrder.id = 99201;
    correctedOrder.amounts.total.amount = 230.0;

    const doc2 = await resubmitCorrectedZatcaInvoice(client, doc1.invoiceId, correctedOrder);

    // Step 4: Verify new document identity and linear hash chain from intervening document
    assert.notEqual(doc2.invoiceUuid, doc1.invoiceUuid, 'Corrected resubmission must have a brand new UUID');
    assert.equal(doc2.icv, 13, 'Corrected document must receive incremented ICV (13)');
    assert.equal(doc2.pih, docIntervening.invoiceHash, 'Corrected document PIH must reference immediately preceding intervening document hash, NOT rejected document');

    // Step 5: Issue subsequent Invoice 3 to verify linear chain continuity
    const order3 = createBaseMockOrder();
    order3.id = 99202;
    const doc3 = await processSallaOrderIntoZatcaInvoice(client, egsId, order3, 'idemp_reject_03');

    assert.equal(doc3.icv, 14, 'Subsequent document must increment ICV to 14');
    assert.equal(doc3.pih, doc2.invoiceHash, 'Subsequent document PIH must reference corrected document hash');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 8: Simplified Invoice Rejection (NOT_REPORTED) Remedy: Credit Note 381 Cancellation & Replacement Invoice', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase8');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_reject_simplified');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_demo_store', 'متجر سلة التجريبي', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET
        store_name = EXCLUDED.store_name,
        vat_number = EXCLUDED.vat_number,
        crn = EXCLUDED.crn`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_demo_store', 'main', 'EGS-DISCOURSE-SIMP-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 20, 'INITIAL_HASH_EDGE8',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge8', 'IOS-POS'
      ) RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    // Step 1: Issue original Simplified Invoice (B2C)
    const baseOrder = createBaseMockOrder();
    baseOrder.id = 99301;
    const doc1 = await processSallaOrderIntoZatcaInvoice(client, egsId, baseOrder, 'idemp_simp_reject_01');
    assert.equal(doc1.icv, 21, 'Original invoice must have ICV 21');
    assert.equal(doc1.isB2C, true, 'Original invoice must be B2C simplified invoice');

    // Step 2: Mark as rejected_reporting (ZATCA Reporting API returned NOT_REPORTED)
    await client.query(
      `UPDATE invoices SET status = 'rejected_reporting' WHERE id = $1`,
      [doc1.invoiceId]
    );

    // Step 3: Remedy via Credit Note (381) + Replacement Invoice
    const remedyResult = await remedyRejectedSimplifiedInvoice(client, doc1.invoiceId);

    // Assert Credit Note
    assert.ok(remedyResult.creditNote.invoiceId, 'Credit note generated');
    assert.equal(remedyResult.creditNote.icv, 22, 'Credit note increments ICV to 22');
    assert.equal(remedyResult.creditNote.pih, doc1.invoiceHash, 'Credit note PIH must point to rejected simplified invoice');
    assert.ok(remedyResult.creditNote.signedXml.includes('381</cbc:InvoiceTypeCode>'), 'Must be code 381');

    // Assert Replacement Invoice
    assert.ok(remedyResult.replacementInvoice.invoiceId, 'Replacement invoice generated');
    assert.notEqual(remedyResult.replacementInvoice.invoiceUuid, doc1.invoiceUuid, 'Replacement invoice must have new UUID');
    assert.equal(remedyResult.replacementInvoice.icv, 23, 'Replacement invoice increments ICV to 23');
    assert.equal(remedyResult.replacementInvoice.pih, remedyResult.creditNote.invoiceHash, 'Replacement invoice PIH must point to Credit Note hash');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 9: Salla Shipment Event Matrix: shipment.created Holds COD, shipment.updated delivered Triggers', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase9');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_shipment');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at, cod_fulfillment_statuses
      ) VALUES (
        'salla_shipment_store', 'متجر الشحن التجريبي', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days', '["completed", "delivered"]'::jsonb
      ) ON CONFLICT (merchant_id) DO UPDATE SET
        store_name = EXCLUDED.store_name,
        vat_number = EXCLUDED.vat_number,
        crn = EXCLUDED.crn`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_shipment_store', 'main', 'EGS-SHIPMENT-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 1, 'INITIAL_HASH_EDGE9',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge9', 'IOS-POS'
      )`,
      [encKey, certPem, encSec]
    );

    // 1. shipment.created in creating status with empty labels: must HOLD, zero tax invoice
    const shipmentCreatedPayload = {
      event: 'shipment.created',
      merchant: 'salla_shipment_store',
      data: {
        order_id: '881001',
        shipment_status: 'creating',
        labels: [],
        courier: { name: 'Aramex' }
      }
    };
    const resCreated = await processSallaWebhookPayload(client, shipmentCreatedPayload as any);
    assert.equal(resCreated.statusCode, 200);
    assert.equal(resCreated.body.status, 'shipment_tracked', 'shipment.created with empty labels must track shipment without issuing invoice');

    // 2. shipment.updated with in_transit & unverified carrier provenance (no courier or tracking): must HOLD
    const shipmentUnverifiedPayload = {
      event: 'shipment.updated',
      merchant: 'salla_shipment_store',
      data: {
        order_id: '881001',
        shipment_status: 'in_transit'
      }
    };
    const resUnverified = await processSallaWebhookPayload(client, shipmentUnverifiedPayload as any);
    assert.equal(resUnverified.statusCode, 200);
    assert.equal(resUnverified.body.status, 'shipment_held_unverified_carrier', 'Must hold shipment event lacking carrier provenance');

    // 3. shipment.updated with future actual_picked_up_at: must REJECT
    const futurePickupTime = new Date(Date.now() + 86400000).toISOString();
    const shipmentFuturePayload = {
      event: 'shipment.updated',
      merchant: 'salla_shipment_store',
      data: {
        order_id: '881001',
        shipment_status: 'in_transit',
        actual_picked_up_at: futurePickupTime,
        tracking_number: 'TRACK-FUTURE-01',
        courier: { name: 'DHL Express' }
      }
    };
    const resFuture = await processSallaWebhookPayload(client, shipmentFuturePayload as any);
    assert.equal(resFuture.statusCode, 200);
    assert.equal(resFuture.body.status, 'invalid_future_pickup_timestamp', 'Must reject handover timestamp set in the future');

    // 4. shipment.updated with in_transit, verified carrier and chronological actual_picked_up_at
    // Triggers commencement of transportation tax point under GCC Unified VAT Agreement Article 23(2)(b) & KSA VAT Regs Article 27
    const shipmentInTransitPayload = {
      event: 'shipment.updated',
      merchant: 'salla_shipment_store',
      data: {
        order_id: '881001',
        shipment_status: 'in_transit',
        actual_picked_up_at: '2026-11-07T14:30:00Z',
        tracking_number: 'TRACK123456',
        courier: { name: 'Aramex', id: 'CR-101' }
      }
    };
    const resInTransit = await processSallaWebhookPayload(client, shipmentInTransitPayload as any);
    assert.equal(resInTransit.statusCode, 200);
    assert.equal(resInTransit.body.status, 'shipment_dispatched', 'Commencement of transport qualifies as date of supply under GCC Agreement Art 23(2)(b) & KSA VAT Regs Art 27');
    assert.equal(resInTransit.body.actual_picked_up_at, '2026-11-07T14:30:00Z', 'Must preserve verified carrier pickup timestamp');

    // 5. Idempotent repeated shipment event
    const resRepeat = await processSallaWebhookPayload(client, shipmentInTransitPayload as any);
    assert.equal(resRepeat.statusCode, 200);
    assert.equal(resRepeat.body.status, 'shipment_already_processed', 'Repeated shipment event must be handled idempotently');

    // 6. shipment.updated with shipment_status = 'delivered' confirms physical delivery
    const shipmentDeliveredPayload = {
      event: 'shipment.updated',
      merchant: 'salla_shipment_store',
      data: {
        order_id: '881002',
        shipment_status: 'delivered'
      }
    };
    const resDelivered = await processSallaWebhookPayload(client, shipmentDeliveredPayload as any);
    assert.equal(resDelivered.statusCode, 200);
    assert.equal(resDelivered.body.status, 'shipment_delivered', 'shipment.updated delivered must confirm physical delivery');

    // 7. order.shipping.address.updated updates address without issuing invoice
    const addressUpdatePayload = {
      event: 'order.shipping.address.updated',
      merchant: 'salla_shipment_store',
      data: {
        order_id: '881001',
        shipping_address: { city: 'Jeddah', street: 'King Road' }
      }
    };
    const resAddress = await processSallaWebhookPayload(client, addressUpdatePayload as any);
    assert.equal(resAddress.statusCode, 200);
    assert.equal(resAddress.body.status, 'address_updated', 'Address update must not issue tax document');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 10: Article 66 Statutory Infrastructure Compliance: 6-Year Retention, Arabic Metadata, Exportability, and Immutability', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase10');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_art66');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_art66_store', 'شركة التجارة السعودية المعتمدة', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET
        store_name = EXCLUDED.store_name,
        vat_number = EXCLUDED.vat_number,
        crn = EXCLUDED.crn`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_art66_store', 'main', 'EGS-ART66-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 50, 'INITIAL_HASH_EDGE10',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge10', 'IOS-POS'
      ) RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    // 1. Generate tax invoice with Arabic metadata
    const order = createBaseMockOrder();
    order.id = 882001;
    order.customer.first_name = 'سلطان';
    order.customer.last_name = 'الشمري';
    order.items[0].name = 'جهاز حاسوب محمول فائق السرعة';

    const invoiceDoc = await processSallaOrderIntoZatcaInvoice(client, egsId, order, 'idemp_art66_01');

    // 2. Arabic Metadata Invariant: UBL XML must contain required Arabic text
    assert.ok(invoiceDoc.signedXml.includes('شركة التجارة السعودية المعتمدة'), 'Must contain Arabic seller name');
    assert.ok(invoiceDoc.signedXml.includes('جهاز حاسوب محمول فائق السرعة'), 'Must contain Arabic line item name');
    assert.ok(invoiceDoc.signedXml.includes('0200000'), 'Must be registered under ZATCA Phase 2 simplified subtype');

    // 3. Electronic Accessibility & 6-Year Retention Horizon:
    // Query invoice by UUID and verify audit availability
    const retrievedRes = await client.query(
      `SELECT id, uuid, egs_unit_id, order_id, icv, invoice_hash, grand_total, status, created_at
       FROM invoices WHERE id = $1`,
      [invoiceDoc.invoiceId]
    );
    assert.equal(retrievedRes.rows.length, 1, 'Invoice must be electronically retrievable in KSA database');
    const invoiceRecord = retrievedRes.rows[0];
    assert.equal(invoiceRecord.uuid, invoiceDoc.invoiceUuid);
    assert.ok(invoiceRecord.created_at, 'Invoice must carry immutable timestamp for 6-year retention tracking');

    // Article 66(1) Retention Calculation:
    // Under Saudi VAT Implementing Regulations Article 66(1), read together with Article 52:
    // 1. Standard tax records: at least 6 years from the END of the relevant tax period (month or quarter).
    // 2. Immovable capital assets permanently attached to real estate: 10-year adjustment + 5 years = 15 years from acquisition.
    // 3. Movable tangible and intangible capital assets: 6-year adjustment + 5 years = 11 years from acquisition.
    // 4. Modified useful life assets: modified adjustment period + 5 years from acquisition.
    function calculateArticle66RetentionDeadline(
      issueDate: Date,
      filerType: 'monthly' | 'quarterly',
      assetCategory?: 'standard' | 'immovable' | 'movable_tangible' | 'intangible' | number
    ): Date {
      if (assetCategory === 'immovable') {
        const deadline = new Date(issueDate);
        deadline.setFullYear(deadline.getFullYear() + 15);
        return deadline;
      }
      if (assetCategory === 'movable_tangible' || assetCategory === 'intangible') {
        const deadline = new Date(issueDate);
        deadline.setFullYear(deadline.getFullYear() + 11);
        return deadline;
      }
      if (typeof assetCategory === 'number') {
        const deadline = new Date(issueDate);
        deadline.setFullYear(deadline.getFullYear() + assetCategory + 5);
        return deadline;
      }
      const year = issueDate.getUTCFullYear();
      const month = issueDate.getUTCMonth();
      let periodEnd: Date;
      if (filerType === 'monthly') {
        periodEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
      } else {
        const quarterEndMonth = Math.floor(month / 3) * 3 + 2;
        periodEnd = new Date(Date.UTC(year, quarterEndMonth + 1, 0, 23, 59, 59, 999));
      }
      const retentionEnd = new Date(periodEnd);
      retentionEnd.setFullYear(retentionEnd.getFullYear() + 6);
      return retentionEnd;
    }

    const testDate = new Date('2026-05-14T10:00:00Z');
    const monthlyDeadline = calculateArticle66RetentionDeadline(testDate, 'monthly');
    assert.equal(monthlyDeadline.toISOString().slice(0, 10), '2032-05-31', 'Monthly filer 6-year retention runs from end of May 2026');

    const quarterlyDeadline = calculateArticle66RetentionDeadline(testDate, 'quarterly');
    assert.equal(quarterlyDeadline.toISOString().slice(0, 10), '2032-06-30', 'Quarterly filer 6-year retention runs from end of Q2 2026');

    const immovableDeadline = calculateArticle66RetentionDeadline(testDate, 'quarterly', 'immovable');
    assert.equal(immovableDeadline.toISOString().slice(0, 10), '2041-05-14', 'Immovable capital asset retention runs 15 years from acquisition');

    const movableDeadline = calculateArticle66RetentionDeadline(testDate, 'quarterly', 'movable_tangible');
    assert.equal(movableDeadline.toISOString().slice(0, 10), '2037-05-14', 'Movable tangible capital asset retention runs 11 years from acquisition');

    const intangibleDeadline = calculateArticle66RetentionDeadline(testDate, 'quarterly', 'intangible');
    assert.equal(intangibleDeadline.toISOString().slice(0, 10), '2037-05-14', 'Intangible capital asset retention runs 11 years from acquisition');

    const customDeadline = calculateArticle66RetentionDeadline(testDate, 'quarterly', 8);
    assert.equal(customDeadline.toISOString().slice(0, 10), '2039-05-14', 'Modified 8-year useful life asset retention runs 13 years from acquisition');

    // 4. Immutability Invariant: Updates to core financial data and deletion must be strictly blocked
    await assert.rejects(
      async () => {
        await client.query(`UPDATE invoices SET grand_total = 999.99 WHERE id = $1`, [invoiceDoc.invoiceId]);
      },
      (err: any) => {
        assert.ok(err.message.includes('TAMPER_EVIDENT_PROTECTION'), 'Database trigger must reject financial alteration');
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await client.query(`DELETE FROM invoices WHERE id = $1`, [invoiceDoc.invoiceId]);
      },
      (err: any) => {
        assert.ok(err.message.includes('TAMPER_EVIDENT_PROTECTION'), 'Database trigger must reject invoice record deletion');
        return true;
      }
    );
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 11: Ordinary Simplified Reporting Rejection Resubmission (No Duplicate Buyer Invoice) vs NOT_REPORTED Remedy', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase11');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_edge11');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_rejection_store', 'متجر معالجة الرفض', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET store_name = EXCLUDED.store_name`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_rejection_store', 'main', 'EGS-REJECT-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 10, 'INITIAL_HASH_EDGE11',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge11', 'IOS-POS'
      ) RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    // 1. Generate an initial simplified invoice (issued and given to buyer)
    const order1 = createBaseMockOrder();
    order1.id = 883001;
    const inv1 = await processSallaOrderIntoZatcaInvoice(client, egsId, order1, 'idemp_rej_01', {
      preservedIssueDate: '2026-10-21'
    });

    // Simulate technical reporting rejection by ZATCA reporting API
    await client.query(`UPDATE invoices SET status = 'rejected_reporting' WHERE id = $1`, [inv1.invoiceId]);

    // Scenario A: Ordinary reporting rejection
    // Under ZATCA E-Invoicing Detailed Technical Guidelines (pages 71–72):
    // The corrected document submitted for reporting must have:
    // - A brand new UUID
    // - An incremented invoice counter value (ICV)
    // - A new unique cryptographic hash
    // - A new generation timestamp (IssueTime)
    // - The original transaction date retained (IssueDate)
    // - Chained to the immediately preceding document emitted by that EGS unit (PIH)
    // - No duplicate invoice delivered to the customer!
    const resubmitRes = await resubmitSimplifiedInvoiceForReporting(client, inv1.invoiceId);
    assert.equal(resubmitRes.status, 'resubmitted_for_reporting');
    assert.notEqual(resubmitRes.replacementUuid, inv1.invoiceUuid, 'Corrected document must carry a new UUID');
    assert.ok(resubmitRes.icv > inv1.icv, 'Corrected document must increment ICV');
    assert.notEqual(resubmitRes.invoiceHash, inv1.invoiceHash, 'Corrected document must generate a new cryptographic hash');
    assert.equal(resubmitRes.pih, inv1.invoiceHash, 'Must maintain EGS hash chain using preceding document hash as PIH');
    assert.equal(resubmitRes.isCustomerDeliveryRequired, false, 'Must NOT deliver duplicate invoice to customer');

    // The rejected document remains immutable in the audit history
    const origInv = await client.query(`SELECT status FROM invoices WHERE id = $1`, [inv1.invoiceId]);
    assert.equal(origInv.rows[0].status, 'rejected_reporting', 'Original rejected invoice must remain immutable in audit ledger');

    // The replacement document has status 'submitted' and links to the rejected invoice
    const repInv = await client.query(`SELECT status, replaces_invoice_id, supply_date FROM invoices WHERE id = $1`, [resubmitRes.replacementInvoiceId]);
    assert.equal(repInv.rows[0].status, 'submitted', 'Replacement document queued with status submitted');
    assert.equal(repInv.rows[0].replaces_invoice_id, inv1.invoiceId, 'Replacement document links to rejected invoice');
    assert.equal(String(repInv.rows[0].supply_date).slice(0, 10), String(order1.date.date).slice(0, 10), 'Must retain original transaction date');

    // Scenario B: ZATCA Reporting API returns NOT_REPORTED
    // Under ZATCA FAQ: Invoice is deemed invalid; taxpayer cancels via Credit Note 381 and generates replacement invoice
    await client.query(`UPDATE invoices SET status = 'rejected_reporting' WHERE id = $1`, [inv1.invoiceId]);
    const remedyRes = await remedyRejectedSimplifiedInvoice(client, inv1.invoiceId);
    assert.ok(remedyRes.creditNote, 'Must generate Credit Note 381 cancelling invalid invoice');
    assert.ok(remedyRes.replacementInvoice, 'Must generate fresh replacement invoice');
    assert.ok(remedyRes.creditNote.icv > resubmitRes.icv, 'Credit note advances ICV');
    assert.ok(remedyRes.replacementInvoice.icv > remedyRes.creditNote.icv, 'Replacement invoice advances ICV');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 12: VAT Return Box 1 Inclusion Invariant: Unreported and Rejected Invoices Maintain Tax Liability', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase12');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_edge12');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_vat_liability_store', 'شركة المحاسبة الضريبية', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET store_name = EXCLUDED.store_name`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_vat_liability_store', 'main', 'EGS-VAT-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 20, 'INITIAL_HASH_EDGE12',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge12', 'IOS-POS'
      ) RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    // Issue invoice 1: successfully reported
    const order1 = createBaseMockOrder();
    order1.id = 884001;
    const inv1 = await processSallaOrderIntoZatcaInvoice(client, egsId, order1, 'idemp_vat_01');
    await client.query(`UPDATE invoices SET status = 'reported' WHERE id = $1`, [inv1.invoiceId]);

    // Issue invoice 2: technical rejection from FATOORA reporting
    const order2 = createBaseMockOrder();
    order2.id = 884002;
    const inv2 = await processSallaOrderIntoZatcaInvoice(client, egsId, order2, 'idemp_vat_02');
    await client.query(`UPDATE invoices SET status = 'rejected_reporting' WHERE id = $1`, [inv2.invoiceId]);

    // Issue invoice 3: pending reporting submission (e.g. within 24h window)
    const order3 = createBaseMockOrder();
    order3.id = 884003;
    const inv3 = await processSallaOrderIntoZatcaInvoice(client, egsId, order3, 'idemp_vat_03');
    await client.query(`UPDATE invoices SET status = 'signed' WHERE id = $1`, [inv3.invoiceId]);

    // Query VAT export aggregation across the merchant's issued invoices
    const vatRes = await client.query(
      `SELECT
         COUNT(*) as total_invoices,
         SUM(subtotal) as total_net,
         SUM(tax_total) as total_vat,
         COUNT(CASE WHEN status NOT IN ('cleared', 'reported', 'cleared_with_warnings', 'reported_with_warnings') THEN 1 END) as pending_or_rejected_count
       FROM invoices
       WHERE egs_unit_id = $1`,
      [egsId]
    );

    const agg = vatRes.rows[0];
    assert.equal(Number(agg.total_invoices), 3, 'All 3 issued invoices exist in ledger');
    assert.equal(Number(agg.total_net), 600.00, 'All 3 invoices contribute to Box 1 Net Sales');
    assert.equal(Number(agg.total_vat), 90.00, 'All 3 invoices contribute to Output VAT liability');
    assert.equal(Number(agg.pending_or_rejected_count), 2, 'Tracks 2 invoices as pending/unreported without altering VAT liability');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 13: Scoped Replacement Insertion on Live PostgreSQL', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase13');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_edge13');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_scoped_store', 'متجر سلة التجريبي', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET store_name = EXCLUDED.store_name`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_scoped_store', 'main', 'EGS-DISCOURSE-SCOPED-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 10, 'INITIAL_HASH_EDGE13',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge13', 'POS'
      ) RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    // 1. Issue original invoice
    const order1 = createBaseMockOrder();
    order1.id = 771001;
    const inv1 = await processSallaOrderIntoZatcaInvoice(client, egsId, order1, 'idemp_scoped_01');
    assert.equal(inv1.icv, 11);

    // 2. Mark as rejected
    await client.query(`UPDATE invoices SET status = 'rejected' WHERE id = $1`, [inv1.invoiceId]);

    // 3. Issue replacement invoice referencing original
    const inv2 = await processSallaOrderIntoZatcaInvoice(
      client,
      egsId,
      order1,
      'idemp_scoped_01:replacement',
      { replacesInvoiceId: inv1.invoiceId }
    );

    assert.equal(inv2.icv, 12, 'Replacement invoice increments ICV cleanly');
    assert.notEqual(inv2.invoiceUuid, inv1.invoiceUuid, 'Replacement has distinct UUID');
    assert.equal(inv2.pih, inv1.invoiceHash, 'PIH chains to rejected original');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 14: Remedy Rejected Simplified Invoice Has Deterministic Credit Note Idempotency Key', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase14');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_edge14');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_idem_store', 'متجر سلة التجريبي', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET store_name = EXCLUDED.store_name`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_idem_store', 'main', 'EGS-DISCOURSE-IDEM-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 40, 'INITIAL_HASH_EDGE14',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge14', 'POS'
      ) RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    // Issue original simplified invoice
    const order = createBaseMockOrder();
    order.id = 772001;
    const inv = await processSallaOrderIntoZatcaInvoice(client, egsId, order, 'idemp_idem_01');
    await client.query(`UPDATE invoices SET status = 'rejected_reporting' WHERE id = $1`, [inv.invoiceId]);

    // First remedy call generates credit note + replacement
    const remedy1 = await remedyRejectedSimplifiedInvoice(client, inv.invoiceId);
    assert.ok(remedy1.creditNote.invoiceId);
    assert.equal(remedy1.creditNote.icv, 42);

    // Second remedy retry must return the same credit note without creating duplicates
    const remedy2 = await remedyRejectedSimplifiedInvoice(client, inv.invoiceId);
    assert.equal(remedy2.creditNote.invoiceId, remedy1.creditNote.invoiceId, 'Must return existing credit note on retry');
    assert.equal(remedy2.creditNote.icv, remedy1.creditNote.icv, 'ICV must not be burned on duplicate remedy');
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 15: Missing Source Order Data Fails Closed with CANNOT_RETRY_WITHOUT_SOURCE_DATA', async () => {
  const pool = new Pool();
  attachStatefulRelationalTestDb(pool);
  const client = await pool.connect();

  try {
    const certDir = join(process.cwd(), '.zatca-test-keys-edgecase15');
    const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('sec_test_edge15');

    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        'salla_nosource_store', 'متجر سلة التجريبي', '300075588700003', '1010010000', $1, $2, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET store_name = EXCLUDED.store_name`,
      [encryptVaultSecret('demo_token'), encryptVaultSecret('demo_refresh')]
    );

    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        'salla_nosource_store', 'main', 'EGS-DISCOURSE-NOSOURCE-01', $1, $2,
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 50, 'INITIAL_HASH_EDGE15',
        'pub_bytes', 'sig_bytes', 'cert_hash', 'egs-uuid-edge15', 'POS'
      ) RETURNING id`,
      [encKey, certPem, encSec]
    );
    const egsId = egsRes.rows[0].id;

    // Insert an invoice directly without raw_order_payload
    const invRes = await client.query(
      `INSERT INTO invoices (
        egs_unit_id, order_id, idempotency_key, invoice_type, uuid,
        icv, pih, invoice_hash, qr_code_payload, signed_xml,
        status, supply_date, issue_timestamp, subtotal, tax_total, grand_total,
        raw_order_payload
      ) VALUES (
        $1, '773001', 'idemp_missing_source', 'simplified_tax_invoice', 'uuid-missing-src-01',
        51, 'PIH_DUMMY', 'HASH_DUMMY', 'QR_DUMMY', '<Invoice/>',
        'rejected', '2026-11-10', '2026-11-10T10:00:00Z', 100, 15, 115,
        NULL
      ) RETURNING id`,
      [egsId]
    );
    const invId = invRes.rows[0].id;

    // Resubmission without correctedOrder and without raw_order_payload must fail closed
    await assert.rejects(
      async () => {
        await resubmitCorrectedZatcaInvoice(client, invId);
      },
      (err: any) => {
        return err.message.includes('CANNOT_RETRY_WITHOUT_SOURCE_DATA');
      }
    );
  } finally {
    client.release();
    await pool.end();
  }
});

test('Discourse Edge Case 16: Refined Voucher Exemption Rules Require Structured Classification', async () => {
  // Test physical merchandise containing 'voucher' in name is NOT exempt
  const physicalOrder = createBaseMockOrder();
  physicalOrder.items = [
    {
      id: 1,
      name: 'Voucher Leather Organizer Wallet',
      quantity: 1,
      price: { amount: 230, currency: 'SAR' }
    }
  ];
  (physicalOrder.items[0] as any).type = 'physical';

  const xmlPhysical = buildUblXmlFromSallaOrder({
    order: physicalOrder,
    uuid: 'uuid-edge-16-a',
    icv: 60,
    pih: 'PIH_DUMMY',
    issueDate: '2026-11-10',
    issueTime: '10:00:00Z',
    sellerNameArabic: 'متجر التجزئة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: true
  });

  // Physical item must be Standard Rated (15%)
  assert.ok(xmlPhysical.includes('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>'), 'Physical item must be Category S');
  assert.ok(!xmlPhysical.includes('VATEX-SA-OOS'), 'Physical item must NOT have VATEX-SA-OOS exemption');

  // Test structured digital multi-purpose voucher IS exempt
  const voucherOrder = createBaseMockOrder();
  voucherOrder.items = [
    {
      id: 2,
      name: 'Digital Voucher Card',
      quantity: 1,
      price: { amount: 500, currency: 'SAR' }
    }
  ];
  (voucherOrder.items[0] as any).is_voucher = true;
  (voucherOrder.items[0] as any).type = 'voucher_multi_purpose';

  const xmlVoucher = buildUblXmlFromSallaOrder({
    order: voucherOrder,
    uuid: 'uuid-edge-16-b',
    icv: 61,
    pih: 'PIH_DUMMY',
    issueDate: '2026-11-10',
    issueTime: '10:00:00Z',
    sellerNameArabic: 'متجر التجزئة',
    sellerVat: '300075588700003',
    sellerCrn: '1010010000',
    isB2C: true
  });

  // Voucher item must be Out-of-scope (Category O with VATEX-SA-OOS)
  assert.ok(xmlVoucher.includes('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">O</cbc:ID>'), 'Voucher must be Category O');
  assert.ok(xmlVoucher.includes('VATEX-SA-OOS'), 'Voucher must have VATEX-SA-OOS exemption code');
});
