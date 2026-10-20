process.env.NODE_ENV = 'test';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool, initializeDatabaseSchema } from '../src/storage/db.js';
import { getSallaMerchantTokens } from '../src/services/salla-oauth.js';
import { validateZatcaPreflight } from '../src/services/zatca-preflight.js';
import { getZatcaOutboundHeaders, classifyGatewayResponse } from '../src/services/outage-classifier.js';
import { generateValidSecp256k1TestCert, attachStatefulRelationalTestDb } from './helpers.js';

let app: FastifyInstance;
const testRunId = Date.now().toString();
const merchantId = `salla_merch_${testRunId}`;
const branchId = `riyadh_hq_${testRunId}`;
let egsUnitId = '';
let b2cSignedInvoiceId = '';
let b2cSignedInvoiceUuid = '';
let b2cSignedQrPayload = '';

before(async () => {
  attachStatefulRelationalTestDb(pool);
  await initializeDatabaseSchema();
  const certDir = join(process.cwd(), '.zatca-test-keys-gates');
  const { certPem } = generateValidSecp256k1TestCert(certDir);
  process.env.ZATCA_SANDBOX_CERT_PEM = certPem;

  app = buildServer();
  await app.ready();
});

after(async () => {
  if (app) {
    await app.close();
  }
  await pool.end();
});

test('Gate 1: Salla OAuth2 Handshake POST /webhooks/salla/authorize & AES-256-GCM Token Vault', async () => {
  const oauthPayload = {
    event: 'app.store.authorize',
    merchant: merchantId,
    created_at: '2026-10-20 12:00:00',
    data: {
      access_token: `salla_live_access_${testRunId}`,
      refresh_token: `salla_live_refresh_${testRunId}`,
      expires_in: 1209600,
      scope: 'offline_access'
    }
  };

  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/salla/authorize',
    payload: oauthPayload
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'authorized');
  assert.equal(body.merchant_id, merchantId);

  // Query PostgreSQL merchant_tokens directly to verify AES-256-GCM encryption at rest
  const dbRes = await pool.query(
    `SELECT access_token_encrypted, refresh_token_encrypted, token_scope
     FROM merchant_tokens
     WHERE merchant_id = $1`,
    [merchantId]
  );
  assert.equal(dbRes.rows.length, 1);
  assert.ok(dbRes.rows[0].access_token_encrypted.startsWith('v1:'), 'access_token_encrypted must start with v1:');
  assert.ok(dbRes.rows[0].refresh_token_encrypted.startsWith('v1:'), 'refresh_token_encrypted must start with v1:');

  // Verify round-trip decryption via getSallaMerchantTokens
  const client = await pool.connect();
  try {
    const decrypted = await getSallaMerchantTokens(client, merchantId);
    assert.ok(decrypted);
    assert.equal(decrypted.merchantId, merchantId);
    assert.equal(decrypted.accessToken, `salla_live_access_${testRunId}`);
    assert.equal(decrypted.refreshToken, `salla_live_refresh_${testRunId}`);
    assert.equal(decrypted.scope, 'offline_access');
  } finally {
    client.release();
  }

  // Also verify GET /api/salla/merchants/:merchantId/tokens endpoint
  const getRes = await app.inject({
    method: 'GET',
    url: `/api/salla/merchants/${merchantId}/tokens`
  });
  assert.equal(getRes.statusCode, 200);
  const getBody = JSON.parse(getRes.body);
  assert.equal(getBody.merchant_id, merchantId);
  assert.equal(getBody.scope, 'offline_access');
});

test('Gate 2: Salla Promo Discounts, Shipping Cost, and COD Fees in <cac:AllowanceCharge> with BR-CO-10 and BR-CO-15 math', async () => {
  // 1. Onboard EGS unit for merchant
  const onboardRes = await app.inject({
    method: 'POST',
    url: '/api/egs/onboard',
    payload: {
      merchantId,
      branchId,
      storeName: 'شركة رواء للملابس الفاخرة',
      vatNumber: '300075588700003',
      otp: '123456',
      isProduction: false
    }
  });

  assert.equal(onboardRes.statusCode, 200, `Onboard failed: ${onboardRes.body}`);
  const onboardBody = JSON.parse(onboardRes.body);
  assert.equal(onboardBody.status, 'onboarded');
  egsUnitId = onboardBody.egs_unit_id;
  assert.ok(egsUnitId);

  // 2. Send Salla order.created with promo discount (20.00), shipping (15.00), COD fee (5.00)
  // sub_total = 200.00, discounts = 20.00, charges = 15.00 + 5.00 = 20.00 -> TaxExclusive = 200.00, Tax = 30.00, Total = 230.00
  const orderId = Number(`200${testRunId.slice(-6)}`);
  const webhookPayload = {
    event: 'order.created',
    merchant: merchantId,
    created_at: '2026-10-20T14:00:00Z',
    data: {
      id: orderId,
      reference_id: `REF-${orderId}`,
      date: {
        date: '2026-10-20 14:00:00',
        timezone: 'Asia/Riyadh'
      },
      status: {
        id: 1,
        name: 'Under Review',
        slug: 'under_review'
      },
      payment_method: 'credit_card',
      currency: 'SAR',
      amounts: {
        sub_total: { amount: 200.00, currency: 'SAR' },
        discounts: { amount: 20.00, currency: 'SAR' },
        shipping_cost: { amount: 15.00, currency: 'SAR' },
        cash_on_delivery: { amount: 5.00, currency: 'SAR' },
        tax: {
          amount: { amount: 30.00, currency: 'SAR' },
          percent: 15
        },
        total: { amount: 230.00, currency: 'SAR' }
      },
      customer: {
        id: 7701,
        first_name: 'سلمان',
        last_name: 'العتيبي',
        tax_number: null
      },
      items: [
        {
          id: 1,
          name: 'ثوب رسمي فاخر',
          sku: 'THB-200',
          quantity: 1,
          price: { amount: 200.00, currency: 'SAR' },
          total: { amount: 200.00, currency: 'SAR' }
        }
      ]
    }
  };

  const webhookRes = await app.inject({
    method: 'POST',
    url: '/webhooks/salla',
    payload: webhookPayload
  });

  assert.equal(webhookRes.statusCode, 200, `Webhook failed: ${webhookRes.body}`);
  const webhookBody = JSON.parse(webhookRes.body);
  assert.equal(webhookBody.status, 'signed_and_recorded');
  b2cSignedInvoiceId = webhookBody.invoice_id;
  b2cSignedInvoiceUuid = webhookBody.invoice_uuid;
  b2cSignedQrPayload = webhookBody.qr_code;

  // 3. Fetch signed XML from PostgreSQL and validate AllowanceCharge & preflight rules
  const invRes = await pool.query(`SELECT signed_xml FROM invoices WHERE id = $1`, [b2cSignedInvoiceId]);
  assert.equal(invRes.rows.length, 1);
  const signedXml: string = invRes.rows[0].signed_xml;

  // Check AllowanceCharge (Discount: ChargeIndicator false, 20.00; Shipping+COD: ChargeIndicator true, 20.00)
  assert.ok(
    signedXml.includes('<cbc:ChargeIndicator>false</cbc:ChargeIndicator>'),
    'Signed XML must include ChargeIndicator false for promo discount'
  );
  assert.ok(
    signedXml.includes('<cbc:ChargeIndicator>true</cbc:ChargeIndicator>'),
    'Signed XML must include ChargeIndicator true for shipping + COD fees'
  );
  assert.ok(
    signedXml.includes('<cbc:AllowanceTotalAmount currencyID="SAR">20.00</cbc:AllowanceTotalAmount>'),
    'AllowanceTotalAmount must be 20.00'
  );
  assert.ok(
    signedXml.includes('<cbc:ChargeTotalAmount currencyID="SAR">20.00</cbc:ChargeTotalAmount>'),
    'ChargeTotalAmount must be 20.00'
  );
  assert.ok(
    signedXml.includes('<cbc:TaxExclusiveAmount currencyID="SAR">200.00</cbc:TaxExclusiveAmount>'),
    'TaxExclusiveAmount must be 200.00'
  );
  assert.ok(
    signedXml.includes('<cbc:TaxInclusiveAmount currencyID="SAR">230.00</cbc:TaxInclusiveAmount>'),
    'TaxInclusiveAmount must be 230.00'
  );

  const preflight = validateZatcaPreflight(signedXml, 'xml');
  assert.equal(preflight.valid, true, `Preflight errors: ${JSON.stringify(preflight.findings)}`);
  assert.equal(preflight.summary.failedChecks, 0);
});

test('Gate 3: B2B Incomplete Buyer National Address Hold Queue & Enrichment POST /api/b2b/orders/:orderId/enrich', async () => {
  // 1. Record current_icv before sending incomplete B2B order
  const beforeEgs = await pool.query(`SELECT current_icv FROM egs_units WHERE id = $1`, [egsUnitId]);
  const icvBefore = Number(beforeEgs.rows[0].current_icv);

  const b2bOrderId = `300${testRunId.slice(-6)}`;
  const incompleteB2bPayload = {
    event: 'order.created',
    merchant: merchantId,
    created_at: '2026-10-20T15:00:00Z',
    data: {
      id: Number(b2bOrderId),
      reference_id: `B2B-${b2bOrderId}`,
      date: {
        date: '2026-10-20 15:00:00',
        timezone: 'Asia/Riyadh'
      },
      status: {
        id: 1,
        name: 'Under Review',
        slug: 'under_review'
      },
      payment_method: 'credit_card',
      currency: 'SAR',
      amounts: {
        sub_total: { amount: 1000.00, currency: 'SAR' },
        tax: {
          amount: { amount: 150.00, currency: 'SAR' },
          percent: 15
        },
        total: { amount: 1150.00, currency: 'SAR' }
      },
      customer: {
        id: 8801,
        first_name: 'فهد',
        last_name: 'المالكي',
        company_name: 'شركة المشتري للتجارة',
        tax_number: '310122393500003'
      },
      shipping: {
        address: {
          country: 'SA',
          city: 'Riyadh',
          street: 'Olaya Main St'
          // Missing building_number, postal_code, district
        }
      },
      items: [
        {
          id: 1,
          name: 'توريد جملة أقمشة رجالية',
          quantity: 10,
          price: { amount: 100.00, currency: 'SAR' },
          total: { amount: 1000.00, currency: 'SAR' }
        }
      ]
    }
  };

  const holdRes = await app.inject({
    method: 'POST',
    url: '/webhooks/salla',
    payload: incompleteB2bPayload
  });

  assert.equal(holdRes.statusCode, 200);
  const holdBody = JSON.parse(holdRes.body);
  assert.equal(holdBody.status, 'pending_b2b_enrichment');
  assert.ok(Array.isArray(holdBody.missing_fields));
  assert.ok(holdBody.missing_fields.includes('building_number_4_digits'));
  assert.ok(holdBody.missing_fields.includes('postal_code_5_digits'));
  assert.ok(holdBody.missing_fields.includes('district_subdivision'));

  // 2. Verify zero ICV burn while in hold queue
  const midEgs = await pool.query(`SELECT current_icv FROM egs_units WHERE id = $1`, [egsUnitId]);
  assert.equal(Number(midEgs.rows[0].current_icv), icvBefore, 'ICV must not increment when B2B order is held');

  // 3. Enrich B2B order with full Saudi National Address
  const enrichRes = await app.inject({
    method: 'POST',
    url: `/api/b2b/orders/${b2bOrderId}/enrich`,
    payload: {
      building_number: '4321',
      postal_code: '12244',
      street: 'Olaya Main St',
      district: 'Al-Olaya',
      city: 'Riyadh',
      company_name: 'شركة المشتري للتجارة'
    }
  });

  assert.equal(enrichRes.statusCode, 200, `Enrich failed: ${enrichRes.body}`);
  const enrichBody = JSON.parse(enrichRes.body);
  assert.equal(enrichBody.status, 'enriched_and_signed');
  assert.equal(Number(enrichBody.icv), icvBefore + 1);

  // 4. Verify signed XML is Standard Tax Invoice (0100000) with BuildingNumber 4321
  const b2bInvRes = await pool.query(`SELECT signed_xml FROM invoices WHERE id = $1`, [enrichBody.invoice_id]);
  assert.equal(b2bInvRes.rows.length, 1);
  const b2bSignedXml: string = b2bInvRes.rows[0].signed_xml;
  assert.ok(b2bSignedXml.includes('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>'));
  assert.ok(b2bSignedXml.includes('<cbc:BuildingNumber>4321</cbc:BuildingNumber>'));
});

test('Gate 4: COD & Bank Transfer Payment Gate defers signing until order completion and prevents duplicate ICV burn', async () => {
  const beforeEgs = await pool.query(`SELECT current_icv FROM egs_units WHERE id = $1`, [egsUnitId]);
  const icvBefore = Number(beforeEgs.rows[0].current_icv);

  const codOrderId = Number(`400${testRunId.slice(-6)}`);
  const baseCodOrder = {
    id: codOrderId,
    reference_id: `COD-${codOrderId}`,
    date: {
      date: '2026-10-20 16:00:00',
      timezone: 'Asia/Riyadh'
    },
    payment_method: 'cod',
    currency: 'SAR',
    amounts: {
      sub_total: { amount: 100.00, currency: 'SAR' },
      tax: {
        amount: { amount: 15.00, currency: 'SAR' },
        percent: 15
      },
      total: { amount: 115.00, currency: 'SAR' }
    },
    customer: {
      id: 9901,
      first_name: 'خالد',
      last_name: 'الدوسري',
      tax_number: null
    },
    items: [
      {
        id: 1,
        name: 'عقال مرعز ملكي',
        quantity: 1,
        price: { amount: 100.00, currency: 'SAR' },
        total: { amount: 100.00, currency: 'SAR' }
      }
    ]
  };

  // 1. Send order.created with payment_method: 'cod' and status.slug: 'under_review'
  const createRes = await app.inject({
    method: 'POST',
    url: '/webhooks/salla',
    payload: {
      event: 'order.created',
      merchant: merchantId,
      created_at: '2026-10-20T16:00:00Z',
      data: {
        ...baseCodOrder,
        status: { id: 1, name: 'Under Review', slug: 'under_review' }
      }
    }
  });

  assert.equal(createRes.statusCode, 200);
  const createBody = JSON.parse(createRes.body);
  assert.equal(createBody.status, 'deferred_payment_hold');

  const afterHoldEgs = await pool.query(`SELECT current_icv FROM egs_units WHERE id = $1`, [egsUnitId]);
  assert.equal(Number(afterHoldEgs.rows[0].current_icv), icvBefore, 'ICV must remain unchanged on deferred_payment_hold');

  // 2. Send order.updated for the same order with status.slug: 'completed'
  const completeRes = await app.inject({
    method: 'POST',
    url: '/webhooks/salla',
    payload: {
      event: 'order.updated',
      merchant: merchantId,
      created_at: '2026-10-20T16:30:00Z',
      data: {
        ...baseCodOrder,
        status: { id: 2, name: 'Completed', slug: 'completed' }
      }
    }
  });

  assert.equal(completeRes.statusCode, 200);
  const completeBody = JSON.parse(completeRes.body);
  assert.equal(completeBody.status, 'signed_and_recorded');
  assert.equal(Number(completeBody.icv), icvBefore + 1);

  const afterCompleteEgs = await pool.query(`SELECT current_icv FROM egs_units WHERE id = $1`, [egsUnitId]);
  assert.equal(Number(afterCompleteEgs.rows[0].current_icv), icvBefore + 1);

  // 3. Send another order.updated for the same order with status.slug: 'delivered'
  const deliveredRes = await app.inject({
    method: 'POST',
    url: '/webhooks/salla',
    payload: {
      event: 'order.updated',
      merchant: merchantId,
      created_at: '2026-10-20T17:00:00Z',
      data: {
        ...baseCodOrder,
        status: { id: 3, name: 'Delivered', slug: 'delivered' }
      }
    }
  });

  assert.equal(deliveredRes.statusCode, 200);
  const deliveredBody = JSON.parse(deliveredRes.body);
  assert.equal(deliveredBody.status, 'idempotent_replay');
  assert.equal(Number(deliveredBody.icv), icvBefore + 1);

  const afterDeliveredEgs = await pool.query(`SELECT current_icv FROM egs_units WHERE id = $1`, [egsUnitId]);
  assert.equal(Number(afterDeliveredEgs.rows[0].current_icv), icvBefore + 1, 'No second ICV increment on subsequent order.updated');
});

test('Gate 5: Printable Bilingual PDF/A-3 Tax Invoice & HTML Endpoints', async () => {
  // 1. Call GET /api/invoices/:id/pdf
  const pdfRes = await app.inject({
    method: 'GET',
    url: `/api/invoices/${b2cSignedInvoiceId}/pdf`
  });

  assert.equal(pdfRes.statusCode, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  const pdfString = pdfRes.rawPayload.toString('utf8');
  assert.ok(pdfString.startsWith('%PDF-1.7'), 'PDF buffer must start with %PDF-1.7');
  assert.ok(pdfString.includes('/EmbeddedFiles'), 'PDF/A-3 must contain /EmbeddedFiles');
  assert.ok(pdfString.includes('ZATCA_eInvoice.xml'), 'PDF/A-3 must embed ZATCA_eInvoice.xml');
  assert.ok(pdfString.includes('/AFRelationship /Alternative'), 'PDF/A-3 must specify /AFRelationship /Alternative');
  assert.ok(pdfString.includes(b2cSignedInvoiceUuid), 'PDF must contain the invoice UUID');

  // 2. Call GET /api/invoices/:id/printable
  const htmlRes = await app.inject({
    method: 'GET',
    url: `/api/invoices/${b2cSignedInvoiceId}/printable`
  });

  assert.equal(htmlRes.statusCode, 200);
  assert.ok(htmlRes.headers['content-type']?.includes('text/html'), 'Content-Type must include text/html');
  assert.ok(htmlRes.body.includes('300075588700003'), 'HTML must contain Seller VAT');
  assert.ok(htmlRes.body.includes(b2cSignedInvoiceUuid), 'HTML must contain Invoice UUID');
  assert.ok(htmlRes.body.includes(b2cSignedQrPayload), 'HTML must contain QR Base64 payload');
});

test('Quirk 1 & Quirk 2: Cloudflare-Safe Outbound Headers & Post-Timeout HTTP 409 Duplicate UUID Recovery', () => {
  // Quirk 1: Outbound headers
  const headers = getZatcaOutboundHeaders('dGVzdA==');
  assert.equal(headers['Accept-Language'], 'ar');
  assert.equal(headers['Accept-Version'], 'V2');
  assert.equal(headers['Accept'], 'application/json');
  assert.ok(headers['User-Agent'].includes('Mozilla/5.0'), 'User-Agent must be a browser User-Agent to bypass Cloudflare');
  assert.equal(headers['Authorization'], 'Basic dGVzdA==');

  // Quirk 2: HTTP 409 Duplicate UUID recovery
  const verdict = classifyGatewayResponse({
    statusCode: 409,
    headers: { 'content-type': 'application/json' },
    rawBody: JSON.stringify({
      code: 'Duplicate-Invoice',
      message: 'Invoice UUID already exists in Fatoora'
    })
  });

  assert.equal(verdict.kind, 'duplicate_uuid_recovered');
});
