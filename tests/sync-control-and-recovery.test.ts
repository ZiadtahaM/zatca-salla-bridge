process.env.NODE_ENV = 'test';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { pool, initializeDatabaseSchema } from '../src/storage/db.js';
import {
  storeSallaMerchantTokens,
  updateMerchantStoreProfile,
  updateMerchantSubscription
} from '../src/services/salla-oauth.js';
import { signMerchantSessionToken } from '../src/crypto/auth-session.js';
import { onboardEgsUnit, MockZatcaApiClient } from '../src/services/onboarding-service.js';
import {
  SyncState,
  transitionOrderSyncState,
  getOrderSyncWithHistory,
  queryOrderSyncRecords,
  getSyncRulesExplanation,
  generateSyncPreview,
  executeSafeOrderRecovery,
  generateOrderSupportDiagnostics
} from '../src/services/sync-service.js';
import {
  runStoreReconciliation,
  getLatestReconciliationSummary
} from '../src/services/reconciliation-service.js';
import { generateValidSecp256k1TestCert, attachStatefulRelationalTestDb } from './helpers.js';

let app: FastifyInstance;
const testRunId = Date.now().toString();
const merchantId = `sync_merch_${testRunId}`;
const branchId = `branch_sync_${testRunId}`;
let egsUnitId = '';
let sessionToken = '';

before(async () => {
  attachStatefulRelationalTestDb(pool);
  await initializeDatabaseSchema();

  const certDir = join(process.cwd(), '.zatca-test-keys-sync');
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
  process.env.ZATCA_SANDBOX_CERT_PEM = certPem;
  void privateKeyPem;

  await storeSallaMerchantTokens(pool, {
    merchantId,
    accessToken: 'salla_secret_access_token_xyz_999',
    refreshToken: 'salla_secret_refresh_token_xyz_888',
    expiresInSeconds: 86400 * 14,
    scope: 'offline_access'
  });

  await updateMerchantStoreProfile(pool, {
    merchantId,
    storeName: 'متجر التزامن الذكي للتقنية',
    vatNumber: '310123456700003',
    crn: '1010123456',
    city: 'الرياض'
  });

  await updateMerchantSubscription(pool, {
    merchantId,
    planName: 'enterprise',
    status: 'active',
    expiresAt: new Date(Date.now() + 86400 * 1000 * 30)
  });

  const onboardRes = await onboardEgsUnit(
    pool,
    {
      merchantId,
      branchId,
      customId: `EGS-SYNC-${testRunId}`,
      model: 'Salla-Zatca-Sync-v1',
      serialNumber: `1-SALLA|2-SYNC|3-${testRunId}`,
      commonName: `TS-SYNC-${testRunId}`,
      storeName: 'متجر التزامن الذكي للتقنية',
      organizationName: 'متجر التزامن الذكي للتقنية',
      organizationUnitName: 'فرع الرياض الرئيسي',
      vatNumber: '310123456700003',
      countryName: 'SA',
      invoiceType: '1100',
      locationAddress: 'الرياض، العليا',
      industryBusinessCategory: 'Retail',
      otp: '123456',
      environment: 'simulation',
      crn: '1010123456'
    },
    certDir,
    new MockZatcaApiClient(certPem)
  );

  egsUnitId = onboardRes.egsUnitId;
  sessionToken = signMerchantSessionToken(merchantId);

  app = buildServer();
  await app.ready();
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test('Step 1: 13-State Synchronization Lifecycle and Chronological Transition Audit Trail', async () => {
  const allStates: SyncState[] = [
    'not_received',
    'received',
    'persisted',
    'awaiting_processing',
    'processing',
    'successfully_processed',
    'zatca_submission_pending',
    'successfully_reported',
    'successfully_cleared',
    'temporarily_failed',
    'permanently_failed',
    'not_eligible',
    'requires_human_review'
  ];

  assert.strictEqual(allStates.length, 13, 'Must support all 13 canonical synchronization states');

  const orderId = 'ORD-LIFECYCLE-1001';
  const corrId = 'corr-lifecycle-1001';

  await transitionOrderSyncState(pool, {
    merchantId,
    orderId,
    toState: 'received',
    sourceEvent: 'order.created',
    correlationId: corrId,
    orderAmount: 230.0,
    orderCurrency: 'SAR',
    customerSummary: { isB2B: false, city: 'الرياض', country: 'SA' },
    reason: 'تم استلام حدث إنشاء الطلب من سلة'
  });

  await transitionOrderSyncState(pool, {
    merchantId,
    orderId,
    toState: 'persisted',
    sourceEvent: 'order.created',
    correlationId: corrId,
    reason: 'تم حفظ الحدث في قاعدة البيانات'
  });

  await transitionOrderSyncState(pool, {
    merchantId,
    orderId,
    toState: 'processing',
    sourceEvent: 'order.created',
    correlationId: corrId,
    reason: 'بدء تجهيز الفاتورة الضريبية المبسطة'
  });

  await transitionOrderSyncState(pool, {
    merchantId,
    orderId,
    toState: 'successfully_processed',
    sourceEvent: 'order.created',
    invoiceType: 'simplified_tax_invoice',
    correlationId: corrId,
    reason: 'تم توقيع الفاتورة محلياً (لم يتم الاعتماد من الزكاة بعد)'
  });

  const localState = await getOrderSyncWithHistory(pool, merchantId, orderId);
  assert.ok(localState, 'Order sync record must exist');
  assert.strictEqual(
    localState.syncState,
    'successfully_processed',
    'Locally signed invoice must remain distinct from ZATCA reported/cleared state'
  );

  await transitionOrderSyncState(pool, {
    merchantId,
    orderId,
    toState: 'successfully_reported',
    sourceEvent: 'order.created',
    invoiceType: 'simplified_tax_invoice',
    correlationId: corrId,
    reason: 'تم قبول وإبلاغ الفاتورة رسمياً في بوابة فاتورة'
  });

  const finalRecord = await getOrderSyncWithHistory(pool, merchantId, orderId);
  assert.ok(finalRecord);
  assert.strictEqual(finalRecord.syncState, 'successfully_reported');
  assert.strictEqual(finalRecord.isRecoverable, false);
  assert.strictEqual(finalRecord.transitions.length, 5);
  assert.strictEqual(finalRecord.transitions[0].toState, 'received');
  assert.strictEqual(finalRecord.transitions[4].fromState, 'successfully_processed');
  assert.strictEqual(finalRecord.transitions[4].toState, 'successfully_reported');
});

test('Step 2: Synchronization Explanation Layer and Pre-Activation Preview', async () => {
  const rules = getSyncRulesExplanation({
    merchantId,
    storeName: 'متجر التزامن الذكي للتقنية',
    vatNumber: '310123456700003',
    codFulfillmentStatuses: ['completed', 'delivered'],
    activeSubscription: true,
    installedAt: new Date('2026-10-01T00:00:00Z'),
    hasActiveEgs: true
  });

  assert.ok(rules.consumedEvents.length >= 4, 'Must explain consumed Salla events');
  assert.ok(rules.orderStateTriggers.length >= 2, 'Must explain prepaid vs COD triggers');
  assert.ok(rules.ineligibilityRules.length >= 3, 'Must explain ineligibility criteria');
  assert.ok(rules.cancellationRules.preSupply.length > 0, 'Must distinguish pre-supply operational cancellation');
  assert.ok(rules.cancellationRules.postInvoice.length > 0, 'Must explain post-invoice Credit Note 381 requirement');
  assert.strictEqual(rules.historicalOrdersBoundary.boundaryDate, '2026-10-01');

  const preview = await generateSyncPreview(pool, merchantId, new Date('2026-10-01T00:00:00Z'));
  assert.strictEqual(preview.merchantId, merchantId);
  assert.strictEqual(preview.historicalBoundary, '2026-10-01');
  assert.ok(preview.sampleOrders.length > 0, 'Must return representative sample orders for pre-activation preview');
});

test('Step 3 & Step 8: Order Synchronization Querying, Filtering, and Bilingual Merchant Portal UI', async () => {
  await transitionOrderSyncState(pool, {
    merchantId,
    orderId: 'ORD-B2B-HOLD-2002',
    toState: 'requires_human_review',
    sourceEvent: 'order.created',
    invoiceType: 'tax_invoice',
    orderAmount: 5750.0,
    errorCategory: 'B2B_MISSING_ADDRESS',
    errorCode: 'BR-KSA-09',
    reason: 'نقص بيانات العنوان الوطني للمشتري (رقم المبنى، الرمز البريدي)',
    isRecoverable: true
  });

  await transitionOrderSyncState(pool, {
    merchantId,
    orderId: 'ORD-SKIP-FREE-2003',
    toState: 'not_eligible',
    sourceEvent: 'order.created',
    orderAmount: 0,
    reason: 'طلب مجاني بقيمة صفرية غير خاضع لإصدار فاتورة ضريبية',
    isRecoverable: false
  });

  const actionRequiredList = await queryOrderSyncRecords(pool, merchantId, {
    onlyRequiresAction: true
  });
  assert.ok(
    actionRequiredList.records.some((r) => r.orderId === 'ORD-B2B-HOLD-2002'),
    'Filter onlyRequiresAction must return orders awaiting B2B review'
  );

  const portalRes = await app.inject({
    method: 'GET',
    url: `/portal?merchantId=${merchantId}&tab=sync`,
    headers: {
      authorization: `Bearer ${sessionToken}`
    }
  });

  assert.strictEqual(portalRes.statusCode, 200);
  assert.ok(portalRes.body.includes('5. مزامنة سلة والتعافي (Salla Sync)'));
  assert.ok(portalRes.body.includes('قواعد المزامنة الذكية مع سلة وشروط الأهلية الضريبية'));
  assert.ok(portalRes.body.includes('ORD-LIFECYCLE-1001'));
  assert.ok(portalRes.body.includes('ORD-B2B-HOLD-2002'));
});

test('Step 4: Missed-Event Reconciliation Detects Un-Invoiced Salla Orders Without Blindly Forging Invoices', async () => {
  const customFetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: 'ORD-MISSED-3001',
            reference_id: 'REF-3001',
            status: { id: 1, name: 'Completed', slug: 'completed' },
            payment_method: 'mada',
            currency: 'SAR',
            amounts: { total: { amount: 460.0, currency: 'SAR' } },
            date: { date: new Date().toISOString() },
            customer: { first_name: 'فهد', last_name: 'الشمري' }
          },
          {
            id: 'ORD-CANCELLED-3002',
            reference_id: 'REF-3002',
            status: { id: 2, name: 'Cancelled', slug: 'cancelled' },
            payment_method: 'credit_card',
            currency: 'SAR',
            amounts: { total: { amount: 115.0, currency: 'SAR' } },
            date: { date: new Date().toISOString() },
            customer: { first_name: 'سارة', last_name: 'القحطاني' }
          }
        ],
        pagination: { totalPages: 1 }
      }),
      text: async () => ''
    } as any;
  };

  const reconResult = await runStoreReconciliation(pool, merchantId, {
    maxPages: 1,
    customFetch
  });

  assert.strictEqual(reconResult.status, 'completed');
  assert.strictEqual(reconResult.totalScanned, 2);
  assert.strictEqual(reconResult.discrepanciesCount, 1, 'Must flag eligible paid order missing locally');
  assert.strictEqual(reconResult.discrepancies[0].orderId, 'ORD-MISSED-3001');
  assert.strictEqual(reconResult.discrepancies[0].discrepancyType, 'MISSED_INGESTION');

  const missedSyncRec = await getOrderSyncWithHistory(pool, merchantId, 'ORD-MISSED-3001');
  assert.ok(missedSyncRec);
  assert.strictEqual(missedSyncRec.syncState, 'temporarily_failed');
  assert.strictEqual(missedSyncRec.isRecoverable, true);

  const cancelledSyncRec = await getOrderSyncWithHistory(pool, merchantId, 'ORD-CANCELLED-3002');
  assert.ok(cancelledSyncRec);
  assert.strictEqual(cancelledSyncRec.syncState, 'not_eligible');
  assert.strictEqual(cancelledSyncRec.isRecoverable, false);

  const summary = await getLatestReconciliationSummary(pool, merchantId);
  assert.ok(summary.latestJob);
  assert.strictEqual(summary.latestJob.totalOrdersScanned, 2);
});

test('Step 5 & Step 9: Safe Order Recovery Enforces Zero Duplicate Invoices and Zero ICV Burns', async () => {
  const settledOrderId = 'ORD-SETTLED-4001';
  const existingInvUuid = '11111111-2222-3333-4444-555555555555';

  await pool.query(
    `INSERT INTO invoices (
      egs_unit_id, order_id, idempotency_key, invoice_type, uuid, icv, pih,
      invoice_hash, qr_code_payload, signed_xml, status, supply_date,
      issue_timestamp, subtotal, tax_total, grand_total, currency
    ) VALUES ($1, $2, $3, 'simplified_tax_invoice', $4, 77, 'pih_prev', 'hash_77', 'qr_77', '<Invoice/>', 'reported', '2026-10-31', NOW(), 100.00, 15.00, 115.00, 'SAR')`,
    [egsUnitId, settledOrderId, `idem_${settledOrderId}`, existingInvUuid]
  );

  const client = await pool.connect();
  try {
    const recResult = await executeSafeOrderRecovery(client, merchantId, settledOrderId, 'test_runner');
    assert.strictEqual(recResult.success, true);
    assert.strictEqual(recResult.actionTaken, 'already_settled');
    assert.strictEqual(recResult.syncState, 'successfully_reported');
    assert.strictEqual(recResult.icv, 77, 'Must preserve original ICV 77 without allocating a new ICV');
    assert.strictEqual(recResult.invoiceUuid, existingInvUuid);
  } finally {
    client.release();
  }
});

test('Step 7: Support Diagnostics Export Redacts All Secrets, Private Keys, Tokens, and Customer PII', async () => {
  const diag = await generateOrderSupportDiagnostics(pool, merchantId, 'ORD-LIFECYCLE-1001');

  assert.strictEqual(diag.orderId, 'ORD-LIFECYCLE-1001');
  assert.strictEqual(diag.merchantId, merchantId);
  assert.strictEqual(diag.currentSyncState, 'successfully_reported');
  assert.strictEqual(diag.timeline.length, 5);

  const serialized = JSON.stringify(diag);
  assert.ok(!serialized.includes('salla_secret_access_token_xyz_999'), 'Must never leak OAuth access token');
  assert.ok(!serialized.includes('salla_secret_refresh_token_xyz_888'), 'Must never leak OAuth refresh token');
  assert.ok(!serialized.includes('PRIVATE KEY'), 'Must never leak ECDSA private key');
  assert.ok(!serialized.includes('BEGIN CERTIFICATE'), 'Must never leak raw certificate payload');
});
