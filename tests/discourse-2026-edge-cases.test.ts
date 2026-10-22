process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUblXmlFromSallaOrder, validateB2bBuyerAddress, isExportCustomer } from '../src/services/invoice-generator.js';
import { validateZatcaPreflight } from '../src/services/zatca-preflight.js';
import { SallaOrderData } from '../src/types/salla.js';

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

test('Discourse Edge Case 4: B2B Down Payments & Prepayment Deduction (386 & BR-CO-16)', () => {
  const order = createBaseMockOrder();
  order.customer.tax_number = '300075588700003';
  order.customer.company_name = 'مؤسسة الرياض للتوريدات';
  order.amounts.sub_total.amount = 1000.0;
  order.amounts.tax.amount.amount = 150.0;
  order.amounts.total.amount = 1150.0;
  order.items[0].price.amount = 1000.0;

  // Final invoice deducting 500 SAR advance deposit
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
    prepaidAmount: 500.0,
    advanceInvoiceId: 'ADV-INV-2026-001',
    advanceInvoiceUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  });

  // Verify PrepaidAmount is 500.00 and PayableAmount is 650.00 (1150 - 500)
  assert.ok(xml.includes('<cbc:PrepaidAmount currencyID="SAR">500.00</cbc:PrepaidAmount>'));
  assert.ok(xml.includes('<cbc:PayableAmount currencyID="SAR">650.00</cbc:PayableAmount>'));

  // Verify 386 Prepayment reference
  assert.ok(xml.includes('<cbc:ID>ADV-INV-2026-001</cbc:ID>'));
  assert.ok(xml.includes('<cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>'));

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
