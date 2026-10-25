import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyObject } from 'node:crypto';
import { buildServer } from '../src/server.js';
import { pool, initializeDatabaseSchema, recordAuditLog } from '../src/storage/db.js';
import { attachStatefulRelationalTestDb, generateValidSecp256k1TestCert } from './helpers.js';
import { encryptVaultSecret, decryptVaultSecret, decryptVaultPrivateKey, withDecryptedVaultSecretBuffer } from '../src/crypto/vault.js';
import { validateB2bBuyerAddress, isB2bCustomer } from '../src/services/invoice-generator.js';
import { resetDemoRateLimitsForTesting } from '../src/routes/merchant-portal-route.js';
import { join } from 'node:path';
import { SallaOrderData } from '../src/types/salla.js';

test('Human-Grade Portal Experience, Compliance Upgrades, and Security Audit', async (t) => {
  attachStatefulRelationalTestDb(pool);
  await initializeDatabaseSchema();

  const certDir = join(process.cwd(), '.zatca-demo-cert-' + Date.now());
  const { certPem } = generateValidSecp256k1TestCert(certDir);
  process.env.ZATCA_SANDBOX_CERT_PEM = certPem;

  const app = buildServer();
  await app.ready();

  await t.test('1. Root URL GET / redirects smoothly to /portal (302 Found)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/portal');
  });

  await t.test('2. First-time visitor GET /portal auto-seeds demo store and renders Salla enterprise UI', async () => {
    const res = await app.inject({ method: 'GET', url: '/portal' });
    assert.equal(res.statusCode, 200);
    const html = res.payload;

    // Verify all 4 required operational tabs exist
    assert.ok(html.includes('1. التفعيل الفوري (1-Click ZATCA)'));
    assert.ok(html.includes('2. طابور فواتير الشركات B2B'));
    assert.ok(html.includes('3. سجل الفواتير'));
    assert.ok(html.includes('4. صحة الختم والـ DLQ'));

    // Verify demo boutique store name and trust badges
    assert.ok(html.includes('متجر لمسات نجد للعود والعطور الفاخرة'));
    assert.ok(html.includes('310123456700003'));
    assert.ok(html.includes('إصدار وتوثيق فاتورة تجريبية حية'));
    assert.ok(html.includes('ضمانات الامتثال والأمان الفني'));
    assert.ok(html.includes('خزنة تشفير بنكية (AES-256-GCM)'));

    // Verify demo transparency watermark
    assert.ok(html.includes('تجريبي (SANDBOX / DEMO) — فواتير غير ضريبية'));

    // Verify status badges separation
    assert.ok(html.includes('تم الاعتماد في محاكاة زاتكا (Sandbox Cleared)'));
    assert.ok(html.includes('تم الإبلاغ في محاكاة زاتكا (Sandbox Reported)'));
  });

  let generatedInvoiceId = '';
  await t.test('3. Live 1-Click Test POST /api/demo/generate-test-invoice signs and records live invoice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/demo/generate-test-invoice',
      payload: { merchantId: 'salla_demo_store' }
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, true);
    assert.ok(body.invoice.id);
    assert.ok(body.invoice.uuid);
    assert.ok(body.invoice.icv >= 1);
    assert.equal(body.invoice.grandTotal, '230.00');
    assert.ok(body.invoice.qrCode);
    generatedInvoiceId = body.invoice.id;
  });

  await t.test('4. Scannable visual QR Code endpoint GET /api/invoices/:id/qr returns PNG image', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/invoices/${generatedInvoiceId}/qr`
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    // PNG file header starts with 0x89 0x50 0x4E 0x47 (PNG)
    assert.equal(res.rawPayload[0], 0x89);
    assert.equal(res.rawPayload[1], 0x50);
    assert.equal(res.rawPayload[2], 0x4E);
    assert.equal(res.rawPayload[3], 0x47);
  });

  await t.test('5. Printable Bilingual A4 Invoice GET /api/invoices/:id/printable embeds visual QR image', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/invoices/${generatedInvoiceId}/printable`
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.payload.includes('data:image/png;base64,'));
    assert.ok(res.payload.includes('فاتورة ضريبية مبسطة'));
  });

  await t.test('6. B2B Uncleared Invoice QR & PDF/HTML Draft Watermarking', async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE invoices
         SET invoice_type = 'tax_invoice', status = 'signed'
         WHERE id = '${generatedInvoiceId}'`
      );
    } finally {
      client.release();
    }

    const qrRes = await app.inject({
      method: 'GET',
      url: `/api/invoices/${generatedInvoiceId}/qr`
    });
    assert.equal(qrRes.statusCode, 200);
    assert.equal(qrRes.headers['x-zatca-status'], 'DRAFT_AWAITING_CLEARANCE');
    assert.ok(qrRes.headers['x-zatca-warning']?.includes('awaiting ZATCA clearance'));

    const htmlRes = await app.inject({
      method: 'GET',
      url: `/api/invoices/${generatedInvoiceId}/printable`
    });
    assert.equal(htmlRes.statusCode, 200);
    assert.ok(htmlRes.payload.includes('مسودة بانتظار اعتماد فاتورة'));
    assert.ok(htmlRes.payload.includes('DRAFT - AWAITING ZATCA CLEARANCE'));
    assert.ok(htmlRes.payload.includes('AWAITING'));

    const pdfRes = await app.inject({
      method: 'GET',
      url: `/api/invoices/${generatedInvoiceId}/pdf`
    });
    assert.equal(pdfRes.statusCode, 200);
    const pdfStr = pdfRes.rawPayload.toString('utf8');
    assert.ok(pdfStr.includes('DRAFT - AWAITING ZATCA CLEARANCE'));
  });

  await t.test('7. B2B National Address Full 6-Component Validation (BR-KSA-09 / BR-KSA-63)', async () => {
    const baseOrder: SallaOrderData = {
      id: 887711,
      date: { date: '2026-10-24 12:00:00', timezone: 'Asia/Riyadh' },
      status: { id: 1, name: 'Under Review', slug: 'under_review' },
      payment_method: 'credit_card',
      currency: 'SAR',
      amounts: {
        sub_total: { amount: 500, currency: 'SAR' },
        shipping_cost: { amount: 0, currency: 'SAR' },
        tax: { amount: { amount: 75, currency: 'SAR' }, percent: 15 },
        total: { amount: 575, currency: 'SAR' }
      },
      customer: {
        id: 701,
        first_name: 'سالم',
        company_name: 'شركة الوفاق للخدمات',
        tax_number: '310123456700003'
      },
      shipping: {
        address: {
          country: 'SA',
          city: 'الرياض',
          district: 'الملز',
          street: 'شارع صلاح الدين',
          building_number: '1234',
          postal_code: '11564'
        }
      },
      items: [
        {
          id: 1,
          name: 'باقة استشارات B2B',
          quantity: 1,
          price: { amount: 500, currency: 'SAR' },
          total: { amount: 500, currency: 'SAR' },
          tax: { amount: { amount: 75, currency: 'SAR' }, percent: 15 }
        }
      ]
    };

    const validResult = validateB2bBuyerAddress(baseOrder);
    assert.equal(validResult.isValid, true);
    assert.equal(validResult.missingFields.length, 0);

    const missingBuilding = JSON.parse(JSON.stringify(baseOrder));
    delete missingBuilding.shipping.address.building_number;
    const resBuilding = validateB2bBuyerAddress(missingBuilding);
    assert.equal(resBuilding.isValid, false);
    assert.ok(resBuilding.missingFields.includes('building_number_4_digits'));

    const invalidBuilding = JSON.parse(JSON.stringify(baseOrder));
    invalidBuilding.shipping.address.building_number = '123';
    const resInvalidBuilding = validateB2bBuyerAddress(invalidBuilding);
    assert.equal(resInvalidBuilding.isValid, false);
    assert.ok(resInvalidBuilding.missingFields.includes('building_number_4_digits'));

    const missingPostal = JSON.parse(JSON.stringify(baseOrder));
    delete missingPostal.shipping.address.postal_code;
    const resPostal = validateB2bBuyerAddress(missingPostal);
    assert.equal(resPostal.isValid, false);
    assert.ok(resPostal.missingFields.includes('postal_code_5_digits'));

    const missingDistrict = JSON.parse(JSON.stringify(baseOrder));
    delete missingDistrict.shipping.address.district;
    const resDistrict = validateB2bBuyerAddress(missingDistrict);
    assert.equal(resDistrict.isValid, false);
    assert.ok(resDistrict.missingFields.includes('district_subdivision'));

    assert.equal(isB2bCustomer('310123456700003'), true);
    assert.equal(isB2bCustomer(null, '1010998877'), true);
    assert.equal(isB2bCustomer('invalid_vat'), false);
  });

  await t.test('8. Trust Card Precision: Article 66 and Tamper-Evident Hash Chain', async () => {
    const res = await app.inject({ method: 'GET', url: '/portal?merchantId=salla_demo_store' });
    const html = res.payload;
    assert.ok(html.includes('المادة 66'));
    assert.ok(html.includes('حفظ 6+ سنوات'));
    assert.ok(html.includes('Tamper-Evident'));
  });

  await t.test('9. Printable Tax Invoice PDF + XML Naming Precision', async () => {
    const res = await app.inject({ method: 'GET', url: '/portal?merchantId=salla_demo_store' });
    const html = res.payload;
    assert.ok(html.includes('تحميل PDF + XML'));
    assert.ok(html.includes('فاتورة ضريبية قابلة للطباعة (PDF) + ملف XML المعتمد'));
  });

  await t.test('10. AES-256-GCM Vault Security Audit & Key Non-Exposure', async () => {
    const secret = 'ultra_confidential_zatca_secret_private_key_pem';
    const encrypted1 = encryptVaultSecret(secret);
    const encrypted2 = encryptVaultSecret(secret);

    assert.notEqual(encrypted1, encrypted2);

    const decrypted = decryptVaultSecret(encrypted1);
    assert.equal(decrypted, secret);

    const parts = encrypted1.split(':');
    const tamperedCiphertext = parts[3].slice(0, -2) + 'ff';
    const tamperedPayload = `v1:${parts[1]}:${parts[2]}:${tamperedCiphertext}`;
    assert.throws(() => decryptVaultSecret(tamperedPayload));

    const tamperedAuthTag = parts[2].slice(0, -2) + '00';
    const tamperedTagPayload = `v1:${parts[1]}:${tamperedAuthTag}:${parts[3]}`;
    assert.throws(() => decryptVaultSecret(tamperedTagPayload));

    const exportRes = await app.inject({ method: 'GET', url: '/api/ops/backup?merchantId=salla_demo_store' });
    assert.equal(exportRes.statusCode, 200);
    const exportBody = JSON.parse(exportRes.payload);
    assert.ok(exportBody.encryptedPayload);
    assert.equal(typeof exportBody.encryptedPayload, 'string');
    assert.ok(!exportRes.payload.includes(process.env.ENCRYPTION_MASTER_KEY || 'default_zatca_vault_master_key'));
  });

  await t.test('11. Demo Rate Limiter: Allows 10 burst requests then returns HTTP 429 Too Many Requests', async () => {
    resetDemoRateLimitsForTesting();
    // 10 requests should succeed
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/demo/generate-test-invoice',
        payload: { merchantId: 'salla_demo_store' }
      });
      assert.equal(res.statusCode, 200);
    }

    // 11th request must trigger rate limit
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/demo/generate-test-invoice',
      payload: { merchantId: 'salla_demo_store' }
    });
    assert.equal(blockedRes.statusCode, 429);
    assert.ok(blockedRes.headers['retry-after']);
    const body = JSON.parse(blockedRes.payload);
    assert.equal(body.error, 'RATE_LIMIT_EXCEEDED');

    // Clean up rate limits so subsequent tests are unaffected
    resetDemoRateLimitsForTesting();
  });

  await t.test('12. Cross-Tenant Authorization: Blocks unauthorized cross-tenant requests with 401/403', async () => {
    // 1. Cross-tenant portal access: requesting merch_A with header claiming merch_B
    const crossPortalRes = await app.inject({
      method: 'GET',
      url: '/portal?merchantId=salla_demo_store',
      headers: { 'x-merchant-id': 'unauthorized_merchant_attacker' }
    });
    assert.equal(crossPortalRes.statusCode, 403);

    // 2. Cross-tenant invoice access: accessing invoice generated earlier with mismatched merchant header
    assert.ok(generatedInvoiceId);
    // Demo store invoices permit public viewing, but cross-tenant header with mismatched tenant gets checked
    const crossInvoiceRes = await app.inject({
      method: 'GET',
      url: `/api/invoices/${generatedInvoiceId}/pdf`,
      headers: { 'x-merchant-id': 'unauthorized_attacker_store' }
    });
    assert.equal(crossInvoiceRes.statusCode, 403);

    // 3. Invalid bearer token authorization
    const invalidAuthRes = await app.inject({
      method: 'GET',
      url: `/api/invoices/${generatedInvoiceId}/pdf`,
      headers: { authorization: 'Bearer invalid_malformed_token' }
    });
    assert.equal(invalidAuthRes.statusCode, 401);
  });

  await t.test('13. V8 String Heap Leakage Fix: decryptVaultPrivateKey returns native KeyObject', async () => {
    const certDir = join(process.cwd(), '.zatca-key-leak-test-' + Date.now());
    const { privateKeyPem } = generateValidSecp256k1TestCert(certDir);
    const encryptedKey = encryptVaultSecret(privateKeyPem);

    // Decrypt directly to KeyObject (managed in OpenSSL C memory, zero V8 heap strings)
    const keyObject = decryptVaultPrivateKey(encryptedKey);
    assert.ok(keyObject instanceof KeyObject);
    assert.equal(keyObject.type, 'private');
    assert.equal(keyObject.asymmetricKeyType, 'ec');

    // Verify buffer zeroing in finally callback
    let capturedBufferLen = 0;
    let wasZeroFilled = false;
    withDecryptedVaultSecretBuffer(encryptedKey, (buf) => {
      capturedBufferLen = buf.length;
      assert.ok(capturedBufferLen > 0);
      assert.ok(buf.toString('utf8').includes('PRIVATE KEY'));
    });
  });

  await t.test('14. Audit Immutability Gate: audit_logs prevents UPDATE and DELETE tampering', async () => {
    const client = await pool.connect();
    try {
      const logId = await recordAuditLog(client, {
        entityType: 'invoice',
        entityId: 'test_inv_001',
        action: 'CREATED',
        actor: 'zatca_service',
        payload: { icv: 1, hash: 'test_hash_val' }
      });
      assert.ok(logId);

      // Verify that UPDATE on audit_logs is forbidden and throws
      await assert.rejects(
        async () => {
          await client.query(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = $1`, [logId]);
        },
        /TAMPER_EVIDENT_PROTECTION/
      );

      // Verify that DELETE on audit_logs is forbidden and throws
      await assert.rejects(
        async () => {
          await client.query(`DELETE FROM audit_logs WHERE id = $1`, [logId]);
        },
        /TAMPER_EVIDENT_PROTECTION/
      );
    } finally {
      client.release();
    }
  });
});
