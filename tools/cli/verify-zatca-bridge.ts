import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { buildServer } from '../../src/server.js';
import { pool, initializeDatabaseSchema } from '../../src/storage/db.js';
import { validateZatcaPreflight } from '../../src/services/zatca-preflight.js';
import { getZatcaOutboundHeaders, classifyGatewayResponse } from '../../src/services/outage-classifier.js';
import { generateValidSecp256k1TestCert, attachStatefulRelationalTestDb } from '../../tests/helpers.js';

interface LeverCheckResult {
  gate: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  evidence: string;
}

async function runLever(): Promise<void> {
  const results: LeverCheckResult[] = [];
  const runId = Date.now().toString();
  const merchantId = `salla_lever_${runId}`;
  const branchId = `riyadh_${runId}`;
  const certDir = join(process.cwd(), `.zatca-lever-keys-${runId}`);

  attachStatefulRelationalTestDb(pool);
  await initializeDatabaseSchema();

  const { certPem } = generateValidSecp256k1TestCert(certDir);
  process.env.ZATCA_SANDBOX_CERT_PEM = certPem;

  const app = buildServer();
  await app.ready();

  try {
    const step = async (gate: string, fn: () => Promise<string>) => {
      const start = performance.now();
      try {
        const evidence = await fn();
        results.push({
          gate,
          status: 'PASS',
          durationMs: Math.round((performance.now() - start) * 100) / 100,
          evidence
        });
      } catch (err: any) {
        results.push({
          gate,
          status: 'FAIL',
          durationMs: Math.round((performance.now() - start) * 100) / 100,
          evidence: err.message || String(err)
        });
        throw err;
      }
    };

    let egsUnitId = '';
    let b2cInvoiceId = '';
    let b2cInvoiceUuid = '';

    await step('0. Dual-Probe Health & Readiness (/health, /ready)', async () => {
      const h = await app.inject({ method: 'GET', url: '/health' });
      const r = await app.inject({ method: 'GET', url: '/ready' });
      assert.equal(h.statusCode, 200);
      assert.equal(r.statusCode, 200);
      return `health=${JSON.parse(h.body).status}, ready=${JSON.parse(r.body).status}`;
    });

    await step('1. Gate 1: Salla OAuth2 Handshake & AES-256-GCM Token Vault', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/salla/authorize',
        payload: {
          event: 'app.store.authorize',
          merchant: merchantId,
          data: {
            access_token: `access_${runId}`,
            refresh_token: `refresh_${runId}`,
            expires_in: 1209600,
            scope: 'offline_access'
          }
        }
      });
      assert.equal(res.statusCode, 200);
      const dbRow = await pool.query(`SELECT access_token_encrypted FROM merchant_tokens WHERE merchant_id = $1`, [merchantId]);
      assert.ok(dbRow.rows[0].access_token_encrypted.startsWith('v1:'));
      return `merchant=${merchantId}, envelope=${dbRow.rows[0].access_token_encrypted.slice(0, 15)}...`;
    });

    await step('2. Automated EGS Onboarding (secp256k1 CSR + Encrypted Vault)', async () => {
      const res = await app.inject({
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
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      egsUnitId = body.egs_unit_id;
      assert.ok(egsUnitId);
      return `egsUnitId=${egsUnitId}, customId=${body.custom_id}`;
    });

    await step('3. Gate 2: <cac:AllowanceCharge> Promo, Shipping & COD Math (BR-CO-10 / BR-CO-15)', async () => {
      const orderId = Number(`20${runId.slice(-6)}`);
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/salla',
        payload: {
          event: 'order.created',
          merchant: merchantId,
          created_at: '2026-10-20T14:00:00Z',
          data: {
            id: orderId,
            date: { date: '2026-10-20 14:00:00', timezone: 'Asia/Riyadh' },
            status: { id: 1, name: 'Under Review', slug: 'under_review' },
            payment_method: 'credit_card',
            currency: 'SAR',
            amounts: {
              sub_total: { amount: 200, currency: 'SAR' },
              discounts: { amount: 20, currency: 'SAR' },
              shipping_cost: { amount: 15, currency: 'SAR' },
              cash_on_delivery: { amount: 5, currency: 'SAR' },
              tax: { amount: { amount: 30, currency: 'SAR' }, percent: 15 },
              total: { amount: 230, currency: 'SAR' }
            },
            customer: { id: 101, first_name: 'سلمان', last_name: 'العتيبي', tax_number: null },
            items: [{ id: 1, name: 'ثوب رسمي فاخر', quantity: 1, price: { amount: 200, currency: 'SAR' }, total: { amount: 200, currency: 'SAR' } }]
          }
        }
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'signed_and_recorded');
      b2cInvoiceId = body.invoice_id;
      b2cInvoiceUuid = body.invoice_uuid;

      const xmlRow = await pool.query(`SELECT signed_xml FROM invoices WHERE id = $1`, [b2cInvoiceId]);
      const audit = validateZatcaPreflight(xmlRow.rows[0].signed_xml, 'xml');
      assert.equal(audit.valid, true);
      return `icv=${body.icv}, preflightScore=${audit.score}%, failedChecks=${audit.summary.failedChecks}`;
    });

    await step('4. Gate 3: B2B Incomplete National Address Hold Queue & Enrichment', async () => {
      const b2bOrderId = `30${runId.slice(-6)}`;
      const holdRes = await app.inject({
        method: 'POST',
        url: '/webhooks/salla',
        payload: {
          event: 'order.created',
          merchant: merchantId,
          created_at: '2026-10-20T15:00:00Z',
          data: {
            id: Number(b2bOrderId),
            date: { date: '2026-10-20 15:00:00', timezone: 'Asia/Riyadh' },
            status: { id: 1, name: 'Under Review', slug: 'under_review' },
            payment_method: 'credit_card',
            currency: 'SAR',
            amounts: {
              sub_total: { amount: 1000, currency: 'SAR' },
              tax: { amount: { amount: 150, currency: 'SAR' }, percent: 15 },
              total: { amount: 1150, currency: 'SAR' }
            },
            customer: { id: 202, first_name: 'فهد', company_name: 'شركة المشتري', tax_number: '310122393500003' },
            shipping: { address: { country: 'SA', city: 'Riyadh', street: 'Olaya St' } },
            items: [{ id: 1, name: 'توريد جملة', quantity: 10, price: { amount: 100, currency: 'SAR' }, total: { amount: 1000, currency: 'SAR' } }]
          }
        }
      });
      const holdBody = JSON.parse(holdRes.body);
      assert.equal(holdBody.status, 'pending_b2b_enrichment');

      const enrichRes = await app.inject({
        method: 'POST',
        url: `/api/b2b/orders/${b2bOrderId}/enrich`,
        payload: {
          building_number: '4321',
          postal_code: '12244',
          street: 'Olaya St',
          district: 'Al-Olaya',
          city: 'Riyadh'
        }
      });
      const enrichBody = JSON.parse(enrichRes.body);
      assert.equal(enrichBody.status, 'enriched_and_signed');
      return `heldMissing=${holdBody.missing_fields.length}, enrichedIcv=${enrichBody.icv}`;
    });

    await step('5. Gate 4: COD & Bank Transfer Payment Gate (deferred_payment_hold -> completed)', async () => {
      const codOrderId = Number(`40${runId.slice(-6)}`);
      const holdRes = await app.inject({
        method: 'POST',
        url: '/webhooks/salla',
        payload: {
          event: 'order.created',
          merchant: merchantId,
          created_at: '2026-10-20T16:00:00Z',
          data: {
            id: codOrderId,
            date: { date: '2026-10-20 16:00:00', timezone: 'Asia/Riyadh' },
            status: { id: 1, name: 'Under Review', slug: 'under_review' },
            payment_method: 'cod',
            currency: 'SAR',
            amounts: {
              sub_total: { amount: 100, currency: 'SAR' },
              tax: { amount: { amount: 15, currency: 'SAR' }, percent: 15 },
              total: { amount: 115, currency: 'SAR' }
            },
            customer: { id: 303, first_name: 'خالد', tax_number: null },
            items: [{ id: 1, name: 'عقال ملكي', quantity: 1, price: { amount: 100, currency: 'SAR' }, total: { amount: 100, currency: 'SAR' } }]
          }
        }
      });
      assert.equal(JSON.parse(holdRes.body).status, 'deferred_payment_hold');

      const doneRes = await app.inject({
        method: 'POST',
        url: '/webhooks/salla',
        payload: {
          event: 'order.updated',
          merchant: merchantId,
          created_at: '2026-10-20T16:30:00Z',
          data: {
            id: codOrderId,
            date: { date: '2026-10-20 16:00:00', timezone: 'Asia/Riyadh' },
            status: { id: 2, name: 'Completed', slug: 'completed' },
            payment_method: 'cod',
            currency: 'SAR',
            amounts: {
              sub_total: { amount: 100, currency: 'SAR' },
              tax: { amount: { amount: 15, currency: 'SAR' }, percent: 15 },
              total: { amount: 115, currency: 'SAR' }
            },
            customer: { id: 303, first_name: 'خالد', tax_number: null },
            items: [{ id: 1, name: 'عقال ملكي', quantity: 1, price: { amount: 100, currency: 'SAR' }, total: { amount: 100, currency: 'SAR' } }]
          }
        }
      });
      const doneBody = JSON.parse(doneRes.body);
      assert.equal(doneBody.status, 'signed_and_recorded');
      return `created=deferred_payment_hold, completedIcv=${doneBody.icv}`;
    });

    await step('6. Gate 5: Bilingual PDF/A-3 with Embedded XML & Printable HTML', async () => {
      const pdfRes = await app.inject({ method: 'GET', url: `/api/invoices/${b2cInvoiceId}/pdf` });
      const htmlRes = await app.inject({ method: 'GET', url: `/api/invoices/${b2cInvoiceId}/printable` });
      assert.equal(pdfRes.statusCode, 200);
      assert.equal(htmlRes.statusCode, 200);
      const pdfStr = pdfRes.rawPayload.toString('utf8');
      assert.ok(pdfStr.startsWith('%PDF-1.7'));
      assert.ok(pdfStr.includes('ZATCA_eInvoice.xml'));
      assert.ok(htmlRes.body.includes(b2cInvoiceUuid));
      return `pdfBytes=${pdfRes.rawPayload.length}, htmlChars=${htmlRes.body.length}`;
    });

    await step('7. Quirks 1 & 2: Cloudflare WAF Headers & HTTP 409 Duplicate UUID Recovery', async () => {
      const headers = getZatcaOutboundHeaders('dGVzdA==');
      assert.equal(headers['Accept-Language'], 'ar');
      assert.equal(headers['Accept-Version'], 'V2');
      const verdict = classifyGatewayResponse({
        statusCode: 409,
        headers: { 'content-type': 'application/json' },
        rawBody: JSON.stringify({ code: 'Duplicate-Invoice', message: 'UUID already exists' })
      });
      assert.equal(verdict.kind, 'duplicate_uuid_recovered');
      return `Accept-Version=${headers['Accept-Version']}, 409Verdict=${verdict.kind}`;
    });

    process.stdout.write('\n=== PSTACK POTETO-MODE VERIFICATION LEVER: ALL GATES GREEN ===\n');
    console.table(results);
  } finally {
    await app.close();
    await pool.end();
    try {
      rmSync(certDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

runLever().catch((err) => {
  process.stderr.write(`Lever verification failed: ${err.message}\n`);
  process.exit(1);
});
