process.env.NODE_ENV = 'test';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
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
import { processPartialCreditNote } from '../src/services/invoice-generator.js';
import { extractQrFromClearedXml } from '../src/services/fatoora-dispatcher.js';
import { generateValidSecp256k1TestCert } from './helpers.js';
import { encryptVaultSecret } from '../src/crypto/vault.js';
import { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let seededEgsUnitId = '';

before(async () => {
  await initializeDatabaseSchema();
  const certDir = join(process.cwd(), '.zatca-test-keys-live-prod');
  const { certPem, privateKeyPem } = generateValidSecp256k1TestCert(certDir);
  process.env.ZATCA_SANDBOX_CERT_PEM = certPem;

  const client = await pool.connect();
  try {
    const encKey = encryptVaultSecret(privateKeyPem);
    const encSec = encryptVaultSecret('secret_123');
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

test('1. Live PostgreSQL Engine: audit_logs immutable trigger blocks UPDATE and DELETE', async () => {
  // Connect directly to live postgres database without in-memory mock interception
  const livePool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://zatca_admin:secret_zatca_password@127.0.0.1:5432/zatca_ledger',
    connectionTimeoutMillis: 4000
  });

  const client = await livePool.connect();
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

test('7. Live PostgreSQL Engine: invoices immutable trigger blocks DELETE and core field tampering', async () => {
  const livePool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://zatca_admin:secret_zatca_password@127.0.0.1:5432/zatca_ledger',
    connectionTimeoutMillis: 4000
  });

  const client = await livePool.connect();
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
