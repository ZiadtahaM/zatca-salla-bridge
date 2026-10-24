import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import { pool, initializeDatabaseSchema } from '../src/storage/db.js';
import { attachStatefulRelationalTestDb, generateValidSecp256k1TestCert } from './helpers.js';
import { join } from 'node:path';

test('Human-Grade Portal Experience: Root redirect, Demo Seeding, Live 1-Click Invoice, and Visual QR', async (t) => {
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
});
