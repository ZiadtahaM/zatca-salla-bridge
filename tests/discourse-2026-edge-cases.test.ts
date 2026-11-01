process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  buildUblXmlFromSallaOrder,
  validateB2bBuyerAddress,
  isExportCustomer,
  resubmitCorrectedZatcaInvoice,
  processSallaOrderIntoZatcaInvoice
} from '../src/services/invoice-generator.js';
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

    // Step 3: Resubmit corrected transaction via resubmitCorrectedZatcaInvoice
    const correctedOrder = createBaseMockOrder();
    correctedOrder.id = 99201;
    correctedOrder.amounts.total.amount = 230.0;

    const doc2 = await resubmitCorrectedZatcaInvoice(client, doc1.invoiceId, correctedOrder);

    // Step 4: Verify new document identity
    assert.notEqual(doc2.invoiceUuid, doc1.invoiceUuid, 'Corrected resubmission must have a brand new UUID');
    assert.equal(doc2.icv, 12, 'Corrected document must receive incremented ICV (12)');
    assert.equal(doc2.pih, hash1, 'Corrected document PIH must reference the rejected document hash position');

    // Step 5: Issue subsequent Invoice 3 to verify linear chain continuity
    const order3 = createBaseMockOrder();
    order3.id = 99202;
    const doc3 = await processSallaOrderIntoZatcaInvoice(client, egsId, order3, 'idemp_reject_03');

    assert.equal(doc3.icv, 13, 'Subsequent document must increment ICV to 13');
    assert.equal(doc3.pih, doc2.invoiceHash, 'Subsequent document PIH must reference corrected document hash');
  } finally {
    client.release();
    await pool.end();
  }
});
