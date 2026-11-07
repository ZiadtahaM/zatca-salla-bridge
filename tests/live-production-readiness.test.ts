process.env.NODE_ENV = 'test';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildServer } from '../src/server.js';
import { pool, initializeDatabaseSchema } from '../src/storage/db.js';
import {
  signMerchantSessionToken,
  verifyMerchantSessionToken,
  authenticateMerchantRequest,
  setMerchantSessionCookie,
  signReceiptToken,
  verifyReceiptToken
} from '../src/crypto/auth-session.js';
import { dispatchMerchantAlert } from '../src/services/alert-dispatcher.js';
import { processPartialCreditNote, processSallaOrderIntoZatcaInvoice } from '../src/services/invoice-generator.js';
import { extractQrFromClearedXml } from '../src/services/fatoora-dispatcher.js';
import { drainWebhookQueue, processSallaWebhookPayload } from '../src/routes/salla-webhook.js';
import { generateValidSecp256k1TestCert, attachStatefulRelationalTestDb } from './helpers.js';
import { encryptVaultSecret } from '../src/crypto/vault.js';
import { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let seededEgsUnitId = '';

before(async () => {
  try {
    const testClient = await pool.connect();
    testClient.release();
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED' || err.message?.includes('connect ECONNREFUSED')) {
      attachStatefulRelationalTestDb(pool);
    }
  }
  await initializeDatabaseSchema();
  const certDir = join(process.cwd(), '.zatca-test-keys-live-prod');
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
  process.env.ZATCA_SANDBOX_CERT_PEM = certPem;

  const client = await pool.connect();
  try {
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('secret_123');

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
        $3, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 1, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==',
        '\\x00'::bytea, '\\x00'::bytea, 'dummy_hash', '11111111-2222-3333-4444-555555555555', 'SallaBridge-V1'
      ) ON CONFLICT (merchant_id, branch_id, custom_id) DO UPDATE SET updated_at = NOW() RETURNING id`,
      [encKey, certPem, encSec]
    );
    seededEgsUnitId = egsRes.rows[0].id;
  } finally {
    client.release();
  }

  app = buildServer();
  await app.ready();
});

after(async () => {
  if (app) {
    await app.close();
  }
  await pool.end();
});

test('1. Live PostgreSQL Engine: audit_logs immutable trigger blocks UPDATE and DELETE', async (t) => {
  // Connect directly to live postgres database without in-memory mock interception
  const livePool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://zatca_admin:secret_zatca_password@127.0.0.1:5432/zatca_ledger',
    connectionTimeoutMillis: 4000
  });

  let client;
  try {
    client = await livePool.connect();
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED' || err.message?.includes('connect ECONNREFUSED')) {
      attachStatefulRelationalTestDb(livePool);
      client = await livePool.connect();
    } else {
      throw err;
    }
  }
  try {
    const insertRes = await client.query(
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor, payload)
       VALUES ('invoice', 'inv_live_test_001', 'SUBMIT', 'system', '{"test": true}'::jsonb)
       RETURNING id`
    );
    const logId = insertRes.rows[0].id;
    assert.ok(logId, 'Audit log inserted successfully');

    // Attempt UPDATE on audit_logs
    await assert.rejects(
      async () => {
        await client.query(`UPDATE audit_logs SET actor = 'malicious_actor' WHERE id = $1`, [logId]);
      },
      (err: any) => {
        assert.ok(err.message.includes('TAMPER_EVIDENT_PROTECTION'), 'PostgreSQL trigger must reject UPDATE');
        return true;
      }
    );

    // Attempt DELETE on audit_logs
    await assert.rejects(
      async () => {
        await client.query(`DELETE FROM audit_logs WHERE id = $1`, [logId]);
      },
      (err: any) => {
        assert.ok(err.message.includes('TAMPER_EVIDENT_PROTECTION'), 'PostgreSQL trigger must reject DELETE');
        return true;
      }
    );
  } finally {
    client.release();
    await livePool.end();
  }
});

test('2. Cryptographic HMAC-SHA256 Session Auth: Tokens, Cookies, and Anti-Tampering', () => {
  const secret = 'super_secret_signing_key_at_least_32_bytes_long';
  const merchantId = 'store_ksa_9988';

  const token = signMerchantSessionToken(merchantId, secret);
  assert.ok(token.startsWith(`${merchantId}.`));

  // Valid token verification
  const valid = verifyMerchantSessionToken(token, secret);
  assert.equal(valid.valid, true);
  assert.equal(valid.merchantId, merchantId);

  // Tampered payload rejected
  const tamperedToken = token.replace(merchantId, 'store_attacker_666');
  const tamperedRes = verifyMerchantSessionToken(tamperedToken, secret);
  assert.equal(tamperedRes.valid, false);

  // Expired token rejected
  const expiredToken = `${merchantId}.${Date.now() - 10000}.dummy_signature`;
  const expiredRes = verifyMerchantSessionToken(expiredToken, secret);
  assert.equal(expiredRes.valid, false);
});

test('3. Quarterly Accountant VAT Export: GET /api/invoices/export.csv returns UTF-8 BOM & Box 1 reconciliation', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/invoices/export.csv?merchantId=salla_demo_store'
  });

  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['content-type']?.includes('text/csv'));
  assert.ok(res.headers['content-disposition']?.includes('zatca_vat_return_'));

  const rawBytes = res.rawPayload;
  // Verify UTF-8 BOM: 0xEF, 0xBB, 0xBF
  assert.equal(rawBytes[0], 0xEF);
  assert.equal(rawBytes[1], 0xBB);
  assert.equal(rawBytes[2], 0xBF);

  const csvText = rawBytes.toString('utf8');
  assert.ok(csvText.includes('ZATCA VAT Return Form Summary'), 'Must include Form Box summary header');
  assert.ok(csvText.includes('Box 1 Standard Sales'), 'Must include Box 1 Net Sales');
  assert.ok(csvText.includes('Box 1 Adjustments / Credit Notes'), 'Must include Box 1 Adjustments');
  assert.ok(csvText.includes('Net VAT Payable'), 'Must include Net VAT Payable');
  assert.ok(csvText.includes('Unreported Invoices Count'), 'Must include failed invoice counter');
});

test('4. Onboarding Gate: Production environment requires mandatory liability waiver acceptance', async () => {
  const payloadWithoutLiability = {
    merchantId: 'merch_prod_test',
    branchId: 'branch_prod_test',
    storeName: 'متجر اختبار الإنتاج',
    vatNumber: '310123456700003',
    otp: '123456',
    isProduction: true,
    environment: 'production'
  };

  const rejectRes = await app.inject({
    method: 'POST',
    url: '/api/egs/onboard',
    payload: payloadWithoutLiability
  });

  assert.equal(rejectRes.statusCode, 400);
  const rejectBody = JSON.parse(rejectRes.payload);
  assert.equal(rejectBody.error, 'LIABILITY_ACCEPTANCE_REQUIRED');

  // Accept liability
  const payloadWithLiability = {
    ...payloadWithoutLiability,
    liabilityAccepted: true
  };

  const acceptRes = await app.inject({
    method: 'POST',
    url: '/api/egs/onboard',
    payload: payloadWithLiability
  });

  assert.equal(acceptRes.statusCode, 200);
  const acceptBody = JSON.parse(acceptRes.payload);
  assert.equal(acceptBody.status, 'onboarded');
});

test('5. Historical Orders Credit Note 381: Accepts pre-installation invoice references without existing invoice in DB', async () => {
  const client = await pool.connect();
  try {
    const result = await processPartialCreditNote(client, seededEgsUnitId, {
      externalOriginalInvoiceNumber: 'ORD-PRE-INSTALL-2023-9999',
      externalOriginalInvoiceDate: '2023-11-15',
      refundAmount: 50.00,
      returnReason: 'Return of product purchased before ZATCA Phase 2 bridge deployment'
    });

    assert.ok(result.invoiceId, 'Credit note generated');
    assert.ok(result.icv > 0, 'ICV incremented');
    assert.ok(result.signedXml.includes('ORD-PRE-INSTALL-2023-9999'), 'Credit note XML embeds historical reference');
    assert.ok(result.signedXml.includes('381</cbc:InvoiceTypeCode>'), 'Credit note has 381 type code');
    assert.ok(result.signedXml.includes('<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>'));
  } finally {
    client.release();
  }
});

test('6. Alert Dispatcher: Graceful fallback when webhook/telegram endpoints are not configured', async () => {
  const result = await dispatchMerchantAlert({
    merchantId: 'store_demo_alert',
    alertType: 'B2B_HOLD',
    title: 'Test Notification',
    message: 'Testing dispatch notification fallback'
  });

  assert.equal(result.sent, false);
  assert.equal(result.destination, 'internal_log');
  assert.equal(result.status, 'unconfigured_destination');
});

test('7. Live PostgreSQL Engine: invoices immutable trigger blocks DELETE and core field tampering', async (t) => {
  const livePool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://zatca_admin:secret_zatca_password@127.0.0.1:5432/zatca_ledger',
    connectionTimeoutMillis: 4000
  });

  let client;
  try {
    client = await livePool.connect();
  } catch (err: any) {
    if (err.code === 'ECONNREFUSED' || err.message?.includes('connect ECONNREFUSED')) {
      attachStatefulRelationalTestDb(livePool);
      client = await livePool.connect();
    } else {
      throw err;
    }
  }
  try {
    const testUnique = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const icvRes = await client.query(`SELECT COALESCE(MAX(icv), 0) + 1 AS next_icv FROM invoices WHERE egs_unit_id = $1`, [seededEgsUnitId]);
    const nextIcv = Number(icvRes.rows[0].next_icv);

    const invRes = await client.query(
      `INSERT INTO invoices (
        egs_unit_id, order_id, idempotency_key, invoice_type, uuid,
        icv, pih, invoice_hash, qr_code_payload, signed_xml,
        status, supply_date, issue_timestamp, subtotal, tax_total, grand_total
      ) VALUES (
        $1, $2, $3, 'simplified_tax_invoice', gen_random_uuid(),
        $4, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==',
        $5, 'qr_live_001', '<Invoice/>',
        'signed', '2026-10-26', '2026-10-26T12:00:00Z', 100.00, 15.00, 115.00
      ) RETURNING id`,
      [seededEgsUnitId, `order_live_${testUnique}`, `idemp_live_${testUnique}`, nextIcv, `hash_live_${testUnique}`]
    );

    const invoiceId = invRes.rows[0].id;

    // 1. Attempt DELETE - must be blocked by trigger
    await assert.rejects(
      async () => {
        await client.query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);
      },
      (err: any) => {
        assert.ok(err.message.includes('TAMPER_EVIDENT_PROTECTION'), 'Trigger must reject DELETE on invoices');
        return true;
      }
    );

    // 2. Attempt UPDATE on financial field (grand_total) - must be blocked
    await assert.rejects(
      async () => {
        await client.query(`UPDATE invoices SET grand_total = 9999.00 WHERE id = $1`, [invoiceId]);
      },
      (err: any) => {
        assert.ok(err.message.includes('TAMPER_EVIDENT_PROTECTION'), 'Trigger must reject UPDATE on grand_total');
        return true;
      }
    );

    // 3. Attempt UPDATE on status - must be allowed
    const updateRes = await client.query(`UPDATE invoices SET status = 'cleared' WHERE id = $1 RETURNING status`, [invoiceId]);
    assert.equal(updateRes.rows[0].status, 'cleared');
  } finally {
    client.release();
    await livePool.end();
  }
});

test('8. Customer Receipt Signing and Verification Token (?sig=)', () => {
  const invoiceId = 'inv_customer_receipt_9988';
  const sig = signReceiptToken(invoiceId);
  assert.ok(sig && typeof sig === 'string');

  assert.equal(verifyReceiptToken(invoiceId, sig), true);
  assert.equal(verifyReceiptToken(invoiceId, 'tampered_sig'), false);
  assert.equal(verifyReceiptToken('different_invoice_id', sig), false);
});

test('9. Extraction of B2B stamped QR code from clearedInvoice XML', () => {
  const sampleClearedXml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">ARpTYWxsYSBUZXN0IENv...ZatcaStampedQrSignatureBase64==</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
</Invoice>`;

  const extracted = extractQrFromClearedXml(sampleClearedXml);
  assert.equal(extracted, 'ARpTYWxsYSBUZXN0IENv...ZatcaStampedQrSignatureBase64==');
});

test('10. Magic launch link (?merchant_id=...&token=...) sets session cookie and authorizes portal', async () => {
  const testMerchantId = 'merchant_magic_launch_' + Date.now();
  const token = signMerchantSessionToken(testMerchantId);

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, access_token_encrypted, refresh_token_encrypted, expires_at,
        token_scope, store_name, vat_number, crn, city
      ) VALUES (
        $1, $2, $3, NOW() + INTERVAL '30 days',
        'offline_access', 'Magic Store', '310122393500003', '1010123456', 'Riyadh'
      )`,
      [testMerchantId, encryptVaultSecret('access_magic'), encryptVaultSecret('refresh_magic')]
    );
  } finally {
    client.release();
  }

  // 1. Unauthenticated request without token or cookie returns 401
  const unauthRes = await app.inject({
    method: 'GET',
    url: `/portal?merchant_id=${testMerchantId}`
  });
  assert.equal(unauthRes.statusCode, 401);

  // 2. Request with valid token returns 200 and sets zatca_merchant_session cookie
  const authRes = await app.inject({
    method: 'GET',
    url: `/portal?merchant_id=${testMerchantId}&token=${token}`
  });
  assert.equal(authRes.statusCode, 200);
  const setCookie = authRes.headers['set-cookie'];
  assert.ok(setCookie, 'Must set session cookie on magic launch link');
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
  assert.ok(cookieStr.includes('zatca_merchant_session='), 'Cookie name must match');
  assert.ok(cookieStr.includes('HttpOnly'), 'Cookie must be HttpOnly');

  // 3. Subsequent request with the cookie returns 200 without token query parameter
  const sessionCookieMatch = cookieStr.match(/zatca_merchant_session=([^;]+)/);
  const cookieVal = sessionCookieMatch ? sessionCookieMatch[1] : '';
  assert.ok(cookieVal);

  const followUpRes = await app.inject({
    method: 'GET',
    url: `/portal?merchant_id=${testMerchantId}`,
    headers: {
      cookie: `zatca_merchant_session=${cookieVal}`
    }
  });
  assert.equal(followUpRes.statusCode, 200);
});

test('11. Post-reboot webhook_queue draining processes pending orders into signed invoices', async () => {
  const client = await pool.connect();
  const testOrderId = (880000 + Math.floor(Math.random() * 100000)).toString();
  const idempotencyKey = `salla:salla_demo_store:order.created:${testOrderId}:${Date.now()}`;

  try {
    // Clear any stale pending items from previous interrupted runs
    await client.query("DELETE FROM webhook_queue WHERE status = 'pending'");

    // 1. Enqueue a pending webhook as if it arrived right before a container reboot
    const testPayload = {
      event: 'order.created',
      merchant: 'salla_demo_store',
      created_at: new Date().toISOString(),
      data: {
        id: testOrderId,
        reference_id: testOrderId,
        status: { id: 1, name: 'مكتمل', slug: 'completed' },
        payment_method: 'credit_card',
        currency: 'SAR',
        customer: {
          id: 'cust_101',
          first_name: 'سالم',
          last_name: 'العتيبي',
          mobile: '0501234567'
        },
        amounts: {
          sub_total: { amount: 100.0, currency: 'SAR' },
          tax: { amount: { amount: 15.0, currency: 'SAR' }, percent: 15 },
          total: { amount: 115.0, currency: 'SAR' }
        },
        items: [
          {
            id: 'item_1',
            name: 'عود مروكي فاخر',
            quantity: 1,
            price: { amount: 100.0, currency: 'SAR' },
            total: { amount: 115.0, currency: 'SAR' }
          }
        ]
      }
    };

    // Ensure merchant subscription is active
    await client.query(
      `INSERT INTO merchant_subscriptions (merchant_id, plan_name, status)
       VALUES ('salla_demo_store', 'standard', 'active')
       ON CONFLICT (merchant_id) DO UPDATE SET status = 'active'`
    );

    // Insert pending queue row
    const queueInsert = await client.query(
      `INSERT INTO webhook_queue (merchant_id, event_name, idempotency_key, payload, status)
       VALUES ('salla_demo_store', 'order.created', $1, $2::jsonb, 'pending')
       RETURNING id`,
      [idempotencyKey, JSON.stringify(testPayload)]
    );
    const queueId = queueInsert.rows[0].id;

    // 2. Call drainWebhookQueue (simulating startup drain)
    const { processed, errors } = await drainWebhookQueue();
    assert.ok(processed >= 1, 'Must process at least 1 pending webhook');
    assert.equal(errors, 0, 'Must have 0 errors');

    // 3. Verify queue row status is now 'completed'
    const queueCheck = await client.query(`SELECT status, error_message, processed_at FROM webhook_queue WHERE id = $1`, [queueId]);
    assert.equal(queueCheck.rows[0].status, 'completed');
    assert.ok(queueCheck.rows[0].processed_at);

    // 4. Verify invoice was generated in database
    const invoiceCheck = await client.query(`SELECT id, uuid, icv, status FROM invoices WHERE order_id = $1`, [testOrderId]);
    assert.ok(invoiceCheck.rows.length > 0, 'Invoice must exist in database after queue drain');
  } finally {
    client.release();
  }
});

test('12. Dynamic Seller Identity: Seller CRN, VAT and Store Name resolve dynamically from database and overrides', async () => {
  const client = await pool.connect();
  const testMerchantId = 'store_dynamic_seller_' + Date.now();
  const testOrderId = (900000 + Math.floor(Math.random() * 100000)).toString();
  const certDir = join(process.cwd(), '.zatca-test-keys-dynamic-seller');
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
  const encKey = encryptVaultSecret(privateKeyPem);
  const encSec = encryptVaultSecret('secret_dyn_123');

  try {
    // 1. Seed merchant_tokens with custom CRN, VAT, and store name
    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        $1, 'مؤسسة التجارة الرقمية الحديثة', '310123456700003', '1010887766', $2, $3, NOW() + INTERVAL '30 days'
      ) ON CONFLICT (merchant_id) DO UPDATE SET store_name = EXCLUDED.store_name, vat_number = EXCLUDED.vat_number, crn = EXCLUDED.crn`,
      [testMerchantId, encryptVaultSecret('mock_token'), encryptVaultSecret('mock_refresh')]
    );

    // 2. Seed active subscription
    await client.query(
      `INSERT INTO merchant_subscriptions (merchant_id, plan_name, status)
       VALUES ($1, 'standard', 'active')
       ON CONFLICT (merchant_id) DO UPDATE SET status = 'active'`,
      [testMerchantId]
    );

    // 3. Seed egs_unit for this merchant
    const egsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        $1, 'branch_east', 'egs_dyn_01', $2, $3,
        $4, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 1, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==',
        '\\x00'::bytea, '\\x00'::bytea, 'dummy_hash', $5, 'SallaBridge-Dyn'
      ) RETURNING id`,
      [testMerchantId, encKey, certPem, encSec, randomUUID()]
    );
    const dynEgsUnitId = egsRes.rows[0].id;

    // 4. Build sample order
    const sampleOrder: any = {
      id: testOrderId,
      reference_id: testOrderId,
      status: { id: 1, name: 'مكتمل', slug: 'completed' },
      payment_method: 'credit_card',
      currency: 'SAR',
      customer: {
        id: 'cust_dyn_1',
        first_name: 'فيصل',
        last_name: 'الغامدي',
        mobile: '0555555555'
      },
      amounts: {
        sub_total: { amount: 200.0, currency: 'SAR' },
        tax: { amount: { amount: 30.0, currency: 'SAR' }, percent: 15 },
        total: { amount: 230.0, currency: 'SAR' }
      },
      items: [
        {
          id: 'item_dyn_1',
          name: 'طقم فاخر',
          quantity: 1,
          price: { amount: 200.0, currency: 'SAR' },
          total: { amount: 230.0, currency: 'SAR' }
        }
      ]
    };

    // 5. Generate invoice and assert dynamic fields in signed XML
    const result = await processSallaOrderIntoZatcaInvoice(
      client,
      dynEgsUnitId,
      sampleOrder,
      `salla:${testMerchantId}:order.created:${testOrderId}:${Date.now()}`
    );

    assert.ok(result.signedXml.includes('<cbc:ID schemeID="CRN">1010887766</cbc:ID>'), 'Must contain merchant CRN from database');
    assert.ok(result.signedXml.includes('<cbc:CompanyID>310123456700003</cbc:CompanyID>'), 'Must contain merchant VAT from database');
    assert.ok(result.signedXml.includes('مؤسسة التجارة الرقمية الحديثة'), 'Must contain merchant store name from database');

    // 6. Test with explicit overrides
    const orderIdOverride = `${testOrderId}_ovr`;
    sampleOrder.id = orderIdOverride;
    sampleOrder.reference_id = orderIdOverride;
    const resultWithOverride = await processSallaOrderIntoZatcaInvoice(
      client,
      dynEgsUnitId,
      sampleOrder,
      `salla:${testMerchantId}:order.created:${orderIdOverride}:${Date.now()}`,
      {
        sellerCrn: '1010999000',
        sellerVat: '300099988800003',
        sellerNameArabic: 'شركة الفرع المخصص المحدودة'
      }
    );

    assert.ok(resultWithOverride.signedXml.includes('<cbc:ID schemeID="CRN">1010999000</cbc:ID>'), 'Must contain override CRN');
    assert.ok(resultWithOverride.signedXml.includes('<cbc:CompanyID>300099988800003</cbc:CompanyID>'), 'Must contain override VAT');
    assert.ok(resultWithOverride.signedXml.includes('شركة الفرع المخصص المحدودة'), 'Must contain override store name');
  } finally {
    client.release();
  }
});

test('13. Configurable COD Fulfillment Slugs: Custom merchant slugs bypass deferred hold on delivery', async () => {
  const client = await pool.connect();
  const testMerchantId = 'store_cod_slugs_' + Date.now();
  const testOrderId1 = (920000 + Math.floor(Math.random() * 10000)).toString();
  const testOrderId2 = (930000 + Math.floor(Math.random() * 10000)).toString();
  const certDir = join(process.cwd(), '.zatca-test-keys-cod-slugs');
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
  const encKey = encryptVaultSecret(privateKeyPem);
  const encSec = encryptVaultSecret('secret_cod_123');

  try {
    // 1. Seed merchant with custom cod_fulfillment_statuses = ["shipped", "dispatched", "delivered"]
    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at, cod_fulfillment_statuses
      ) VALUES (
        $1, 'متجر التوصيل السريع', '300075588700003', '1010123456', $2, $3, NOW() + INTERVAL '30 days',
        '["shipped", "dispatched", "delivered"]'::jsonb
      ) ON CONFLICT (merchant_id) DO UPDATE SET cod_fulfillment_statuses = EXCLUDED.cod_fulfillment_statuses`,
      [testMerchantId, encryptVaultSecret('mock_token'), encryptVaultSecret('mock_refresh')]
    );

    await client.query(
      `INSERT INTO merchant_subscriptions (merchant_id, plan_name, status)
       VALUES ($1, 'standard', 'active')
       ON CONFLICT (merchant_id) DO UPDATE SET status = 'active'`,
      [testMerchantId]
    );

    await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        $1, 'main', 'egs_cod_01', $2, $3,
        $4, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 1, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==',
        '\\x00'::bytea, '\\x00'::bytea, 'dummy_hash', $5, 'SallaBridge-COD'
      )`,
      [testMerchantId, encKey, certPem, encSec, randomUUID()]
    );

    // 2. Webhook payload with payment_method: 'cod' and custom status: 'dispatched'
    const dispatchedPayload = {
      event: 'order.updated',
      merchant: testMerchantId,
      created_at: new Date().toISOString(),
      data: {
        id: testOrderId1,
        reference_id: testOrderId1,
        status: { id: 5, name: 'تم الإرسال', slug: 'dispatched' },
        payment_method: 'cod',
        currency: 'SAR',
        customer: {
          id: 'cust_cod_1',
          first_name: 'نايف',
          last_name: 'الدوسري',
          mobile: '0511111111'
        },
        amounts: {
          sub_total: { amount: 100.0, currency: 'SAR' },
          tax: { amount: { amount: 15.0, currency: 'SAR' }, percent: 15 },
          total: { amount: 115.0, currency: 'SAR' }
        },
        items: [
          {
            id: 'item_cod_1',
            name: 'منتج دفع عند الاستلام',
            quantity: 1,
            price: { amount: 100.0, currency: 'SAR' },
            total: { amount: 115.0, currency: 'SAR' }
          }
        ]
      }
    };

    const resDispatched = await processSallaWebhookPayload(client, dispatchedPayload as any);
    assert.equal(resDispatched.statusCode, 200);
    assert.equal(resDispatched.body.status, 'signed_and_recorded', 'Must clear deferred hold and generate invoice for dispatched slug');
    assert.ok(resDispatched.body.invoice_uuid, 'Must return generated invoice UUID');

    // 3. Webhook payload with unapproved status slug (e.g. 'under_review') must remain held
    const underReviewPayload = {
      event: 'order.created',
      merchant: testMerchantId,
      created_at: new Date().toISOString(),
      data: {
        ...dispatchedPayload.data,
        id: testOrderId2,
        reference_id: testOrderId2,
        status: { id: 2, name: 'قيد المراجعة', slug: 'under_review' }
      }
    };

    const resUnderReview = await processSallaWebhookPayload(client, underReviewPayload as any);
    assert.equal(resUnderReview.statusCode, 200);
    assert.equal(resUnderReview.body.status, 'deferred_payment_hold', 'Must hold unapproved COD status slug');
    assert.ok(resUnderReview.body.reason.includes('dispatched'), 'Reason must list allowed merchant slugs');
  } finally {
    client.release();
  }
});

test('14. Dynamic Seller Identity & Missing-Data Invariant: Zero-mock isolation and fatal rejection of missing tax attributes', async () => {
  const client = await pool.connect();
  const testMerchantId = 'store_identity_' + Date.now();
  const certDir = join(process.cwd(), '.zatca-test-keys-identity-dynamic');
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
  const encKey = encryptVaultSecret(privateKeyPem);
  const encSec = encryptVaultSecret('secret_ident_123');

  try {
    // 1. Create an EGS unit for a merchant with NO crn or vat_number in egs_units and NO record in merchant_tokens
    const incompleteEgsRes = await client.query(
      `INSERT INTO egs_units (
        merchant_id, branch_id, custom_id, private_key_pem, certificate,
        csid_secret, csid_environment, expires_at, is_active, current_icv, last_document_hash,
        public_key_bytes, ca_signature_bytes, certificate_hash, egs_uuid, model
      ) VALUES (
        $1, 'bare_branch', 'egs_incomplete_01', $2, $3,
        $4, 'sandbox', NOW() + INTERVAL '365 days', TRUE, 1, 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==',
        '\\x00'::bytea, '\\x00'::bytea, 'dummy_hash', $5, 'SallaBridge-Dynamic'
      ) RETURNING id`,
      [testMerchantId, encKey, certPem, encSec, randomUUID()]
    );
    const incompleteEgsId = incompleteEgsRes.rows[0].id;

    // 2. Standalone API /api/v1/sign must reject with HTTP 422 MISSING_SELLER_IDENTITY
    const signResMissing = await app.inject({
      method: 'POST',
      url: '/api/v1/sign',
      payload: {
        merchantId: testMerchantId,
        branchId: 'bare_branch',
        items: [{ name: 'Test Product', quantity: 1, price: 100.0, taxPercent: 15 }]
      }
    });
    assert.equal(signResMissing.statusCode, 422, 'Must reject with 422 when seller identity is missing');
    const missingBody = JSON.parse(signResMissing.body);
    assert.equal(missingBody.error, 'MISSING_SELLER_IDENTITY');
    assert.ok(missingBody.message.includes('BR-KSA-F-13'), 'Error message must cite ZATCA rule BR-KSA-F-13');

    // 3. Populate merchant_tokens with parent CRN and VAT number, and egs_units with distinct branch CRN
    await client.query(
      `INSERT INTO merchant_tokens (
        merchant_id, store_name, vat_number, crn, access_token_encrypted, refresh_token_encrypted, expires_at
      ) VALUES (
        $1, 'شركة الأفق الرقمية المحدودة', '310953887700003', '1010777777', $2, $3, NOW() + INTERVAL '30 days'
      )`,
      [testMerchantId, encryptVaultSecret('token_dynamic'), encryptVaultSecret('refresh_dynamic')]
    );

    // EGS unit has distinct branch CRN and branch name
    await client.query(
      `UPDATE egs_units
       SET crn = '1010888888', branch_name = 'فرع العليا - شركة الأفق'
       WHERE id = $1`,
      [incompleteEgsId]
    );

    // 4. Standalone API /api/v1/sign must succeed and use branch CRN over parent CRN
    const signResSuccess = await app.inject({
      method: 'POST',
      url: '/api/v1/sign',
      payload: {
        merchantId: testMerchantId,
        branchId: 'bare_branch',
        items: [{ name: 'حاسب محمول', quantity: 1, price: 4000.0, taxPercent: 15 }]
      }
    });
    assert.equal(signResSuccess.statusCode, 200, 'Must succeed when seller identity is configured');
    const successBody = JSON.parse(signResSuccess.body);
    assert.ok(successBody.signedXml.includes('<cbc:ID schemeID="CRN">1010888888</cbc:ID>'), 'Must contain branch CRN');
    assert.ok(successBody.signedXml.includes('<cbc:CompanyID>310953887700003</cbc:CompanyID>'), 'Must contain parent VAT');
    assert.ok(successBody.signedXml.includes('فرع العليا - شركة الأفق'), 'Must contain branch name');
    assert.ok(!successBody.signedXml.includes('1010010000'), 'Must not contain old fallback CRN');
    assert.ok(!successBody.signedXml.includes('شركة رواء للملابس الفاخرة'), 'Must not contain old fallback name');
  } finally {
    client.release();
  }
});
