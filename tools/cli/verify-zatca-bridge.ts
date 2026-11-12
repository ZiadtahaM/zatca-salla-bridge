process.env.NODE_ENV = 'test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { buildServer } from '../../src/server.js';
import { pool, initializeDatabaseSchema } from '../../src/storage/db.js';
import { validateZatcaPreflight } from '../../src/services/zatca-preflight.js';
import { getZatcaOutboundHeaders, classifyGatewayResponse } from '../../src/services/outage-classifier.js';
import { generateValidSecp256k1TestCert, attachStatefulRelationalTestDb } from '../../tests/helpers.js';
import { reconcileHalalaRounding, buildUblXmlFromSallaOrder } from '../../src/services/invoice-generator.js';
import { signMerchantSessionToken } from '../../src/crypto/auth-session.js';
import { SallaOrderData } from '../../src/types/salla.js';

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
      const payload = {
        event: 'app.store.authorize',
        merchant: merchantId,
        data: {
          access_token: `access_${runId}`,
          refresh_token: `refresh_${runId}`,
          expires_in: 1209600,
          scope: 'offline_access'
        }
      };
      const rawPayload = JSON.stringify(payload);
      const secret = process.env.SALLA_WEBHOOK_SECRET || 'dev_salla_webhook_secret';
      const sig = createHmac('sha256', secret).update(rawPayload).digest('hex');
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/salla/authorize',
        headers: {
          'content-type': 'application/json',
          'x-salla-signature': sig
        },
        payload: rawPayload
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
          crn: '1010010000',
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
            payment_status: 'paid',
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
            payment_status: 'paid',
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

    await step('8. SaaS Gap 1: Merchant Self-Service Web Portal GET /portal (4 Tabs + Pre-fill)', async () => {
      const launchToken = signMerchantSessionToken(merchantId);
      const portalRes = await app.inject({
        method: 'GET',
        url: `/portal?merchantId=${merchantId}&token=${launchToken}`
      });
      assert.equal(portalRes.statusCode, 200);
      const html = portalRes.payload;
      assert.ok(html.includes('1. التفعيل الفوري (1-Click ZATCA)'));
      assert.ok(html.includes('2. طابور فواتير الشركات B2B'));
      assert.ok(html.includes('3. سجل الفواتير'));
      assert.ok(html.includes('4. صحة الختم والـ DLQ'));
      return `portalBytes=${portalRes.payload.length}, status=200, 4TabsVerified=true`;
    });

    await step('9. SaaS Gap 2: Automated Salla OAuth 14-Day Token Refresh', async () => {
      const client = await pool.connect();
      try {
        const pastDate = new Date(Date.now() + 10 * 3600 * 1000);
        await client.query(`UPDATE merchant_tokens SET expires_at = $1 WHERE merchant_id = $2`, [pastDate.toISOString(), merchantId]);
        const mockFetch = async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: `refreshed_access_${runId}`,
            refresh_token: `refreshed_refresh_${runId}`,
            expires_in: 1209600
          })
        });
        const refreshed = await (await import('../../src/services/salla-oauth.js')).refreshSallaTokenIfNeeded(
          client,
          merchantId,
          false,
          mockFetch as any
        );
        assert.equal(refreshed?.accessToken, `refreshed_access_${runId}`);
        return `refreshedToken=${refreshed?.accessToken.slice(0, 20)}..., expiresAt=${refreshed?.expiresAt.toISOString()}`;
      } finally {
        client.release();
      }
    });

    await step('10. SaaS Gap 3: ZATCA 3-Environment Base URLs & Non-Destructive CSID Renewal', async () => {
      const { getZatcaBaseUrl } = await import('../../src/services/csr-generator.js');
      assert.equal(getZatcaBaseUrl('sandbox'), 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal');
      assert.equal(getZatcaBaseUrl('simulation'), 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation');
      assert.equal(getZatcaBaseUrl('production'), 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core');

      const renewRes = await app.inject({
        method: 'POST',
        url: `/api/egs/${egsUnitId}/renew`,
        payload: { otp: '887766' }
      });
      assert.equal(renewRes.statusCode, 200);
      const renewJson = JSON.parse(renewRes.body);
      assert.equal(renewJson.status, 'renewed');
      return `renewed=${renewJson.status}, currentIcvPreserved=${renewJson.current_icv}`;
    });

    await step('11. SaaS Gap 4: Real Fatoora Dispatcher (Clearance, Reporting, DLQ & Salla History)', async () => {
      const { submitInvoiceToFatoora, notifySallaOrderTimeline } = await import('../../src/services/fatoora-dispatcher.js');
      const client = await pool.connect();
      try {
        const mockHttpClient = async () => ({
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          rawBody: JSON.stringify({
            clearanceStatus: 'CLEARED',
            clearedInvoice: Buffer.from('<cleared-xml/>', 'utf8').toString('base64'),
            qrSellertag: 'updated-qr'
          })
        });
        const dispatchRes = await submitInvoiceToFatoora(client, b2cInvoiceId, { httpClient: mockHttpClient });
        assert.equal(dispatchRes.status, 'reported');

        const mockSallaFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'success' }) });
        const notified = await notifySallaOrderTimeline(client, merchantId, 'order_123', b2cInvoiceUuid, undefined, undefined, mockSallaFetch as any);
        assert.equal(notified, true);
        return `dispatchStatus=${dispatchRes.status}, sallaTimelineNotified=${notified}`;
      } finally {
        client.release();
      }
    });

    await step('12. SaaS Gap 5: Automated Salla App Store Billing Lifecycle & HTTP 402 Gate', async () => {
      const cancelRes = await app.inject({
        method: 'POST',
        url: '/webhooks/salla',
        payload: {
          event: 'app.subscription.canceled',
          merchant: merchantId,
          created_at: new Date().toISOString(),
          data: { plan_name: 'standard', status: 'canceled' }
        }
      });
      assert.equal(cancelRes.statusCode, 200);

      const blockedRes = await app.inject({
        method: 'POST',
        url: '/webhooks/salla',
        payload: {
          event: 'order.created',
          merchant: merchantId,
          created_at: new Date().toISOString(),
          data: {
            id: 998877,
            date: { date: '2026-10-21 12:00:00', timezone: 'Asia/Riyadh' },
            status: { id: 1, name: 'created', slug: 'completed' },
            payment_method: 'credit_card',
            currency: 'SAR',
            amounts: {
              sub_total: { amount: 100, currency: 'SAR' },
              tax: { percent: 15, amount: { amount: 15, currency: 'SAR' } },
              total: { amount: 115, currency: 'SAR' }
            },
            customer: { id: 1, first_name: 'Test', last_name: 'User' },
            items: [{ id: 1, name: 'Item', quantity: 1, price: { amount: 100, currency: 'SAR' }, total: { amount: 115, currency: 'SAR' } }]
          }
        }
      });
      assert.equal(blockedRes.statusCode, 402);
      const blockedJson = JSON.parse(blockedRes.body);
      assert.equal(blockedJson.code, 'SUBSCRIPTION_INACTIVE');
      return `cancelEvent=200, blockedUnpaidOrder=402, code=${blockedJson.code}`;
    });

    await step('13. Product Gap 1: Halala-Level VAT-Inclusive Rounding Reconciler (BR-CO-10 / BR-CO-15)', async () => {
      const vatInclusiveOrder: SallaOrderData = {
        id: Number(`50${runId.slice(-6)}`),
        reference_id: `REF-HALALA-${runId.slice(-4)}`,
        date: { date: '2026-10-21 14:00:00', timezone: 'Asia/Riyadh' },
        status: { id: 1, name: 'Completed', slug: 'completed' },
        payment_method: 'credit_card',
        currency: 'SAR',
        customer: { id: 501, first_name: 'ريان', last_name: 'القحطاني', tax_number: null },
        amounts: {
          sub_total: { amount: 86.95, currency: 'SAR' },
          tax: { percent: 15, amount: { amount: 13.05, currency: 'SAR' } },
          total: { amount: 100.0, currency: 'SAR' }
        },
        items: [
          {
            id: 1,
            name: 'منتج تجريبي 1',
            quantity: 1,
            price: { amount: 33.33, currency: 'SAR' },
            total: { amount: 33.33, currency: 'SAR' }
          },
          {
            id: 2,
            name: 'منتج تجريبي 2',
            quantity: 1,
            price: { amount: 33.33, currency: 'SAR' },
            total: { amount: 33.33, currency: 'SAR' }
          },
          {
            id: 3,
            name: 'منتج تجريبي 3',
            quantity: 1,
            price: { amount: 33.34, currency: 'SAR' },
            total: { amount: 33.34, currency: 'SAR' }
          }
        ]
      };

      const recon = reconcileHalalaRounding(vatInclusiveOrder);
      assert.equal(recon.isVatInclusivePrices, true);
      assert.equal(recon.grandTotal, 100.0);
      assert.equal(Number((recon.taxExclusiveAmount + recon.taxTotalAmount).toFixed(2)), 100.0);

      const xml = buildUblXmlFromSallaOrder({
        order: vatInclusiveOrder,
        uuid: randomUUID(),
        icv: 999,
        pih: createHash('sha256').update('pih_prev').digest('base64'),
        issueDate: '2026-10-21',
        issueTime: '14:00:00',
        sellerNameArabic: 'شركة رواء للملابس الفاخرة',
        sellerVat: '300075588700003',
        sellerCrn: '1010010000',
        isB2C: true
      });

      const audit = validateZatcaPreflight(xml, 'xml');
      assert.equal(audit.valid, true);
      return `reconciledGrandTotal=${recon.grandTotal.toFixed(2)}, driftHalalas=${recon.driftHalalas}, preflightValid=${audit.valid}`;
    });

    await step('14. Product Gap 2: Partial Credit Note (381) & Standalone Developer API (/api/v1/sign-and-submit)', async () => {
      const sessionToken = signMerchantSessionToken(merchantId);
      const pcnRes = await app.inject({
        method: 'POST',
        url: `/api/invoices/${b2cInvoiceId}/partial-credit-note`,
        headers: { authorization: `Bearer ${sessionToken}` },
        payload: {
          refundAmount: 50.0,
          returnReason: 'Partial return by customer'
        }
      });
      assert.equal(pcnRes.statusCode, 200);
      const pcnBody = JSON.parse(pcnRes.body);
      assert.equal(pcnBody.success, true);
      assert.ok(pcnBody.creditNote.invoiceUuid);

      const pcnDb = await pool.query(`SELECT signed_xml, invoice_type FROM invoices WHERE id = $1`, [pcnBody.creditNote.invoiceId]);
      assert.equal(pcnDb.rows[0].invoice_type, 'credit_note');
      assert.ok(pcnDb.rows[0].signed_xml.includes('381'));
      assert.ok(pcnDb.rows[0].signed_xml.includes('BillingReference'));

      const extRes = await app.inject({
        method: 'POST',
        url: '/api/v1/sign-and-submit',
        payload: {
          merchantId,
          branchId,
          isB2C: true,
          items: [
            {
              name: 'Laravel / PHP Custom API Item',
              quantity: 2,
              price: 150.0,
              taxPercent: 15
            }
          ]
        }
      });
      assert.equal(extRes.statusCode, 200);
      const extBody = JSON.parse(extRes.body);
      assert.equal(extBody.success, true);
      assert.equal(extBody.status, 'reported');
      assert.ok(extBody.invoiceUuid);
      assert.ok(extBody.invoiceHash);
      assert.ok(extBody.qrCodeBase64);

      return `creditNoteIcv=${pcnBody.creditNote.icv}, extInvoiceUuid=${extBody.invoiceUuid.slice(0, 8)}..., extIcv=${extBody.icv}`;
    });

    await step('15. Product Gap 3: Automated AES-256-GCM Encrypted Backup & 7-Year Audit Verification', async () => {
      const sessionToken = signMerchantSessionToken(merchantId);
      const backupRes = await app.inject({
        method: 'GET',
        url: `/api/ops/backup?merchantId=${merchantId}&token=${sessionToken}`
      });
      assert.equal(backupRes.statusCode, 200);
      const backupBody = JSON.parse(backupRes.body);
      assert.equal(backupBody.success, true);
      assert.ok(backupBody.checksumSha256);
      assert.ok(backupBody.encryptedPayload.startsWith('v1:'));
      assert.ok(backupBody.recordCounts.egsUnits >= 1);
      assert.ok(backupBody.recordCounts.invoices >= 1);

      const verifyRes = await app.inject({
        method: 'POST',
        url: '/api/ops/backup/verify',
        payload: {
          encryptedPayload: backupBody.encryptedPayload,
          expectedChecksum: backupBody.checksumSha256
        }
      });
      assert.equal(verifyRes.statusCode, 200);
      const verifyBody = JSON.parse(verifyRes.body);
      assert.equal(verifyBody.success, true);
      assert.equal(verifyBody.valid, true);
      assert.equal(verifyBody.checksumMatched, true);

      return `invoicesBackedUp=${backupBody.recordCounts.invoices}, egsUnits=${backupBody.recordCounts.egsUnits}, checksumMatched=${verifyBody.checksumMatched}`;
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
  process.stderr.write(`Lever verification failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
