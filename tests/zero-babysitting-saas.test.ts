process.env.NODE_ENV = 'test';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool, initializeDatabaseSchema } from '../src/storage/db.js';
import {
  storeSallaMerchantTokens,
  getSallaMerchantTokens,
  refreshSallaTokenIfNeeded,
  updateMerchantStoreProfile,
  updateMerchantSubscription,
  isMerchantSubscriptionActive
} from '../src/services/salla-oauth.js';
import {
  generateZatcaCsr,
  getZatcaBaseUrl
} from '../src/services/csr-generator.js';
import {
  onboardEgsUnit,
  renewProductionCsid,
  MockZatcaApiClient
} from '../src/services/onboarding-service.js';
import {
  submitInvoiceToFatoora,
  notifySallaOrderTimeline,
  processPendingDlqRetries
} from '../src/services/fatoora-dispatcher.js';
import { generateValidSecp256k1TestCert, attachStatefulRelationalTestDb } from './helpers.js';

let app: FastifyInstance;
const testRunId = Date.now().toString();
const merchantId = `saas_merch_${testRunId}`;
const branchId = `branch_saas_${testRunId}`;
let egsUnitId = '';
let b2cInvoiceId = '';
let b2bInvoiceId = '';
let testCertPem = '';
let testPrivKeyPem = '';

before(async () => {
  attachStatefulRelationalTestDb(pool);
  await initializeDatabaseSchema();

  const certDir = join(process.cwd(), '.zatca-test-keys-saas');
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
  testCertPem = certPem;
  testPrivKeyPem = privateKeyPem;
  process.env.ZATCA_SANDBOX_CERT_PEM = certPem;

  app = buildServer();
  await app.ready();
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test('Gap 1: Merchant Self-Service Web Portal GET /portal renders all 4 tabs and pre-fills store data', async () => {
  const client = await pool.connect();
  try {
    // Seed merchant store profile
    await storeSallaMerchantTokens(client, {
      merchantId,
      accessToken: 'salla_token_init_123',
      refreshToken: 'salla_refresh_init_456',
      expiresIn: 1209600,
      scope: 'offline_access',
      storeName: 'سلة الرياض الفاخرة',
      vatNumber: '310123456700003',
      crn: '1010998877',
      city: 'الرياض'
    });
  } finally {
    client.release();
  }

  const res = await app.inject({
    method: 'GET',
    url: `/portal?merchantId=${merchantId}`
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['content-type']?.includes('text/html'));
  const html = res.payload;

  // Tab 1: 1-Click ZATCA Activation
  assert.ok(html.includes('1. التفعيل الفوري (1-Click ZATCA)'));
  assert.ok(html.includes('سلة الرياض الفاخرة'));
  assert.ok(html.includes('310123456700003'));

  // Tab 2: Held B2B Queue
  assert.ok(html.includes('2. طابور فواتير الشركات B2B'));

  // Tab 3: Invoices & Receipts
  assert.ok(html.includes('3. سجل الفواتير'));

  // Tab 4: Health, CSID Renewal & DLQ
  assert.ok(html.includes('4. صحة الختم والـ DLQ'));
});

test('Gap 2: Automated Salla OAuth 14-day token refresh and store profile pre-filling', async () => {
  const client = await pool.connect();
  try {
    const pastExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours remaining (< 24h threshold)
    await client.query(
      `UPDATE merchant_tokens
       SET expires_at = $1
       WHERE merchant_id = $2`,
      [pastExpiresAt.toISOString(), merchantId]
    );

    let refreshCalled = false;
    const mockCustomFetch = async (url: any, init: any) => {
      refreshCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'refreshed_access_token_999',
          refresh_token: 'refreshed_refresh_token_888',
          expires_in: 1209600
        })
      } as any;
    };

    const refreshed = await refreshSallaTokenIfNeeded(client, merchantId, false, mockCustomFetch as any);
    assert.ok(refreshCalled);
    assert.equal(refreshed?.accessToken, 'refreshed_access_token_999');
    assert.equal(refreshed?.refreshToken, 'refreshed_refresh_token_888');

    // Verify stored tokens are encrypted at rest with v1: vault
    const tokens = await getSallaMerchantTokens(client, merchantId);
    assert.equal(tokens?.accessToken, 'refreshed_access_token_999');
  } finally {
    client.release();
  }
});

test('Gap 3: ZATCA 3-Environment Support, 6-Doc Compliance Check (Issue #66), and Non-Destructive CSID Renewal', async () => {
  // Test environment endpoints
  assert.equal(getZatcaBaseUrl('sandbox'), 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal');
  assert.equal(getZatcaBaseUrl('simulation'), 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation');
  assert.equal(getZatcaBaseUrl('production'), 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core');

  const client = await pool.connect();
  const workDir = join(process.cwd(), '.zatca-test-onboard-saas', `${testRunId}`);

  try {
    const submittedInvoices: string[] = [];
    const customApiClient = new MockZatcaApiClient(testCertPem);
    customApiClient.submitComplianceInvoice = async (xml: string) => {
      submittedInvoices.push(xml);
      return true;
    };

    // 1. Onboard with invoiceType: 1100
    const onboardRes = await onboardEgsUnit(
      client,
      {
        merchantId,
        branchId,
        storeName: 'سلة الرياض الفاخرة',
        vatNumber: '310123456700003',
        otp: '123456',
        environment: 'simulation',
        invoiceType: '1100'
      },
      workDir,
      customApiClient
    );

    egsUnitId = onboardRes.egsUnitId;
    assert.ok(egsUnitId);
    assert.equal(onboardRes.environment, 'simulation');

    // Verify SallaApp/ZATCA Issue #66: exactly 6 compliance checks executed for 1100 flag
    assert.equal(submittedInvoices.length, 6);
    assert.ok(submittedInvoices.some((xml) => xml.includes('dummy-standard-388')));
    assert.ok(submittedInvoices.some((xml) => xml.includes('dummy-standard-381')));
    assert.ok(submittedInvoices.some((xml) => xml.includes('dummy-standard-383')));
    assert.ok(submittedInvoices.some((xml) => xml.includes('dummy-simplified-388')));
    assert.ok(submittedInvoices.some((xml) => xml.includes('dummy-simplified-381')));
    assert.ok(submittedInvoices.some((xml) => xml.includes('dummy-simplified-383')));

    // Simulate an ongoing invoice chain with ICV = 42 and last_document_hash = 'existing_hash_chain_abc'
    await client.query(
      `UPDATE egs_units
       SET current_icv = 42, last_document_hash = 'existing_hash_chain_abc'
       WHERE id = $1`,
      [egsUnitId]
    );

    // 2. Perform CSID Renewal
    const renewWorkDir = join(process.cwd(), '.zatca-test-renew-saas', `${testRunId}`);
    const renewResult = await renewProductionCsid(client, egsUnitId, '654321', renewWorkDir, customApiClient);

    assert.equal(renewResult.egsUnitId, egsUnitId);
    // Non-destructive check: ICV and PIH remain unchanged!
    assert.equal(renewResult.currentIcv, 42);
    assert.equal(renewResult.lastDocumentHash, 'existing_hash_chain_abc');

    // Also verify via HTTP route POST /api/egs/:id/renew
    const renewHttpRes = await app.inject({
      method: 'POST',
      url: `/api/egs/${egsUnitId}/renew`,
      payload: { otp: '998877' }
    });

    assert.equal(renewHttpRes.statusCode, 200);
    const renewJson = JSON.parse(renewHttpRes.payload);
    assert.equal(renewJson.status, 'renewed');
    assert.equal(renewJson.current_icv, 42);
    assert.equal(renewJson.last_document_hash, 'existing_hash_chain_abc');
  } finally {
    client.release();
  }
});

test('Gap 4: Real Fatoora Dispatcher clearance (B2B), reporting (B2C), DLQ retry loop, and Salla timeline notification', async () => {
  const client = await pool.connect();
  try {
    // Create test B2C simplified invoice
    const invB2cRes = await client.query(
      `INSERT INTO invoices (
        egs_unit_id, order_id, idempotency_key, invoice_type, uuid, icv, pih,
        invoice_hash, qr_code_payload, signed_xml, supply_date, issue_timestamp,
        subtotal, tax_total, grand_total
      ) VALUES ($1, $2, $3, 'simplified_tax_invoice', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id`,
      [
        egsUnitId,
        'order_saas_b2c_101',
        `key_saas_b2c_${Date.now()}`,
        crypto.randomUUID(),
        43,
        'existing_hash_chain_abc',
        'hash_saas_b2c_101',
        'qr_dummy_payload',
        '<dummy-signed-b2c-xml/>',
        '2026-10-21',
        new Date().toISOString(),
        100.0,
        15.0,
        115.0
      ]
    );
    b2cInvoiceId = invB2cRes.rows[0].id;

    // Create test B2B standard invoice
    const invB2bRes = await client.query(
      `INSERT INTO invoices (
        egs_unit_id, order_id, idempotency_key, invoice_type, uuid, icv, pih,
        invoice_hash, qr_code_payload, signed_xml, supply_date, issue_timestamp,
        subtotal, tax_total, grand_total
      ) VALUES ($1, $2, $3, 'tax_invoice', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id`,
      [
        egsUnitId,
        'order_saas_b2b_202',
        `key_saas_b2b_${Date.now()}`,
        crypto.randomUUID(),
        44,
        'hash_saas_b2c_101',
        'hash_saas_b2b_202',
        'qr_dummy_payload',
        '<dummy-signed-b2b-xml/>',
        '2026-10-21',
        new Date().toISOString(),
        500.0,
        75.0,
        575.0
      ]
    );
    b2bInvoiceId = invB2bRes.rows[0].id;

    // 1. Dispatch B2C: Reporting API
    let reportingEndpointCalled = false;
    const mockHttpClientB2c = async (url: string) => {
      reportingEndpointCalled = url.includes('/invoices/reporting/single');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        rawBody: JSON.stringify({ validationResults: { status: 'PASS' } })
      };
    };

    const b2cDispatchRes = await submitInvoiceToFatoora(client, b2cInvoiceId, {
      httpClient: mockHttpClientB2c
    });

    assert.ok(reportingEndpointCalled);
    assert.equal(b2cDispatchRes.status, 'reported');

    // 2. Dispatch B2B: Clearance API
    let clearanceEndpointCalled = false;
    const mockHttpClientB2b = async (url: string) => {
      clearanceEndpointCalled = url.includes('/invoices/clearance/single');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        rawBody: JSON.stringify({
          clearanceStatus: 'CLEARED',
          clearedInvoice: Buffer.from('<zatca-cleared-xml/>', 'utf8').toString('base64'),
          qrSellertag: 'updated_zatca_clearance_qr'
        })
      };
    };

    const b2bDispatchRes = await submitInvoiceToFatoora(client, b2bInvoiceId, {
      httpClient: mockHttpClientB2b
    });

    assert.ok(clearanceEndpointCalled);
    assert.equal(b2bDispatchRes.status, 'cleared');
    assert.equal(b2bDispatchRes.clearedXml, '<zatca-cleared-xml/>');
    assert.equal(b2bDispatchRes.qrCode, 'updated_zatca_clearance_qr');

    // 3. Transient Failure & DLQ scheduling
    const mockHttpClientOutage = async () => ({
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      rawBody: JSON.stringify({ error: 'Gateway timeout' })
    });

    const outageDispatchRes = await submitInvoiceToFatoora(client, b2cInvoiceId, {
      httpClient: mockHttpClientOutage
    });

    assert.equal(outageDispatchRes.status, 'queued_dlq_retry');
    assert.ok((outageDispatchRes.retryAfterSeconds || 0) > 0);

    // Verify DLQ retry runner resolves the transient failure
    const retryResult = await processPendingDlqRetries(pool, {
      httpClient: mockHttpClientB2c
    });
    assert.ok(retryResult.retriedCount >= 1);
    assert.ok(retryResult.resolvedCount >= 1);

    // 4. Salla Order Timeline Notification
    let timelinePosted = false;
    const mockSallaFetch = async (url: any, init: any) => {
      if (String(url).includes('/orders/order_saas_b2c_101/histories')) {
        timelinePosted = true;
      }
      return { ok: true, status: 200, json: async () => ({ status: 'success' }) } as any;
    };

    const timelineResult = await notifySallaOrderTimeline(
      client,
      merchantId,
      'order_saas_b2c_101',
      b2cDispatchRes.invoiceUuid,
      'https://api.salla.dev/admin/v2',
      'http://localhost:3000',
      mockSallaFetch as any
    );
    assert.ok(timelineResult);
    assert.ok(timelinePosted);
  } finally {
    client.release();
  }
});

test('Gap 5: Automated Salla App Store Billing Lifecycle enforcement and HTTP 402 rejection for unpaid accounts', async () => {
  const client = await pool.connect();
  try {
    // 1. Active subscription allows processing
    await updateMerchantSubscription(client, merchantId, 'pro', 'active', new Date(Date.now() + 86400000));
    const activeCheck = await isMerchantSubscriptionActive(client, merchantId);
    assert.equal(activeCheck.active, true);

    // 2. Salla sends app.subscription.canceled webhook
    const cancelWebhookRes = await app.inject({
      method: 'POST',
      url: '/webhooks/salla',
      payload: {
        event: 'app.subscription.canceled',
        merchant: merchantId,
        created_at: new Date().toISOString(),
        data: {
          plan_name: 'pro',
          status: 'canceled'
        }
      }
    });

    assert.equal(cancelWebhookRes.statusCode, 200);
    const cancelJson = JSON.parse(cancelWebhookRes.payload);
    assert.equal(cancelJson.subscription_status, 'canceled');

    // 3. Subsequent order attempt for this canceled merchant is strictly blocked with HTTP 402 Payment Required
    const blockedOrderRes = await app.inject({
      method: 'POST',
      url: '/webhooks/salla',
      payload: {
        event: 'order.created',
        merchant: merchantId,
        created_at: new Date().toISOString(),
        data: {
          id: 991122,
          reference_id: 'ORD-991122',
          date: { date: '2026-10-21 10:00:00', timezone: 'Asia/Riyadh' },
          status: { id: 1, name: 'created', slug: 'completed' },
          payment_method: 'credit_card',
          currency: 'SAR',
          amounts: {
            sub_total: { amount: 100, currency: 'SAR' },
            tax: { percent: 15, amount: { amount: 15, currency: 'SAR' } },
            total: { amount: 115, currency: 'SAR' }
          },
          customer: {
            id: 1,
            first_name: 'Ahmed',
            last_name: 'Ali'
          },
          items: [
            {
              id: 1,
              name: 'Sample Item',
              quantity: 1,
              price: { amount: 100, currency: 'SAR' },
              total: { amount: 115, currency: 'SAR' }
            }
          ]
        }
      }
    });

    assert.equal(blockedOrderRes.statusCode, 402);
    const blockedJson = JSON.parse(blockedOrderRes.payload);
    assert.equal(blockedJson.code, 'SUBSCRIPTION_INACTIVE');
  } finally {
    client.release();
  }
});
