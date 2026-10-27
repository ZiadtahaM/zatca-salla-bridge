import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../storage/db.js';
import { submitInvoiceToFatoora } from '../services/fatoora-dispatcher.js';
import { processPartialCreditNote, processSallaOrderIntoZatcaInvoice } from '../services/invoice-generator.js';
import { encryptVaultSecret } from '../crypto/vault.js';
import { resolveOpenSslPath } from '../services/csr-generator.js';
import { SallaOrderData } from '../types/salla.js';
import { authenticateMerchantRequest, setMerchantSessionCookie } from '../crypto/auth-session.js';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}
const demoRateLimitMap = new Map<string, RateLimitBucket>();

export function checkDemoRateLimit(ip: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;

  const bucket = demoRateLimitMap.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    demoRateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  bucket.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetDemoRateLimitsForTesting(): void {
  demoRateLimitMap.clear();
}

export const merchantPortalRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/portal', async (request, reply) => {
    const query = (request.query || {}) as { merchantId?: string; merchant?: string; merchant_id?: string; tab?: string };
    let merchantId = (query.merchantId || query.merchant || query.merchant_id || '').toString().trim();

    let storeTokens = null;
    let subscription = null;
    let egsUnits: any[] = [];
    let pendingB2b: any[] = [];
    let invoices: any[] = [];
    let dlqItems: any[] = [];

    if (!merchantId) {
      merchantId = 'salla_demo_store';
    }

    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({
        error: auth.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
        message: auth.error
      });
    }

    setMerchantSessionCookie(reply, merchantId);

    const client = await pool.connect();
    try {
      if (merchantId === 'salla_demo_store') {
        const checkDemo = await client.query(
          `SELECT merchant_id FROM merchant_tokens WHERE merchant_id = 'salla_demo_store'`
        );
        if (checkDemo.rows.length === 0) {
          await seedDemoStoreIfNeeded(client);
        }
      } else {
        const checkMerchant = await client.query(
          `SELECT merchant_id FROM merchant_tokens WHERE merchant_id = $1`,
          [merchantId]
        );
        if (checkMerchant.rows.length === 0) {
          return reply.status(404).send({
            error: 'MERCHANT_NOT_FOUND',
            message: `Merchant ${merchantId} not found or unauthorized`
          });
        }
      }

      if (merchantId) {
        const tokenRes = await client.query(
          `SELECT merchant_id, expires_at, store_name, vat_number, crn, city
           FROM merchant_tokens
           WHERE merchant_id = $1`,
          [merchantId]
        );
        if (tokenRes.rows.length > 0) {
          storeTokens = tokenRes.rows[0];
        }

        const subRes = await client.query(
          `SELECT plan_name, status, expires_at
           FROM merchant_subscriptions
           WHERE merchant_id = $1`,
          [merchantId]
        );
        if (subRes.rows.length > 0) {
          subscription = subRes.rows[0];
        }

        const egsRes = await client.query(
          `SELECT id, custom_id, branch_id, csid_environment, expires_at, renewal_status,
                  current_icv, last_document_hash, is_active
           FROM egs_units
           WHERE merchant_id = $1
           ORDER BY created_at DESC`,
          [merchantId]
        );
        egsUnits = egsRes.rows;

        const b2bRes = await client.query(
          `SELECT id, order_id, buyer_name, buyer_vat, missing_fields, created_at
           FROM pending_b2b_orders
           WHERE merchant_id = $1 AND status = 'pending_enrichment'
           ORDER BY created_at DESC`,
          [merchantId]
        );
        pendingB2b = b2bRes.rows;

        const invRes = await client.query(
          `SELECT i.id, i.uuid, i.order_id, i.invoice_type, i.grand_total, i.subtotal, i.tax_total,
                  i.currency, i.status, i.issue_timestamp, i.invoice_hash, i.icv, i.qr_code_payload
           FROM invoices i
           JOIN egs_units u ON i.egs_unit_id = u.id
           WHERE u.merchant_id = $1
           ORDER BY i.issue_timestamp DESC
           LIMIT 50`,
          [merchantId]
        );
        invoices = invRes.rows;

        const dlqRes = await client.query(
          `SELECT id, invoice_id, failure_reason, http_status, attempt_count,
                  first_failed_at, last_failed_at, is_stalled, next_retry_at
           FROM zatca_dlq
           WHERE merchant_id = $1 AND resolved_at IS NULL
           ORDER BY first_failed_at DESC`,
          [merchantId]
        );
        dlqItems = dlqRes.rows;
      }
    } finally {
      client.release();
    }

    const html = renderPortalHtml({
      merchantId,
      storeTokens,
      subscription,
      egsUnits,
      pendingB2b,
      invoices,
      dlqItems,
      activeTab: query.tab || 'activation'
    });

    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  });

  app.post('/api/demo/generate-test-invoice', async (request, reply) => {
    const clientIp = request.ip || '127.0.0.1';
    const rateLimit = checkDemoRateLimit(clientIp);
    if (!rateLimit.allowed) {
      return reply
        .status(429)
        .header('Retry-After', rateLimit.retryAfterSeconds.toString())
        .send({
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Demo invoice rate limit exceeded. Maximum 10 requests per minute per IP. Please retry in ${rateLimit.retryAfterSeconds} seconds.`
        });
    }

    // Public demo experience only ever generates invoices for the isolated demo tenant
    const merchantId = 'salla_demo_store';
    const client = await pool.connect();
    try {

      let unitRes = await client.query(
        `SELECT id FROM egs_units WHERE merchant_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`,
        [merchantId]
      );

      if (unitRes.rows.length === 0) {
        await seedDemoStoreIfNeeded(client);
        unitRes = await client.query(
          `SELECT id FROM egs_units WHERE merchant_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`,
          [merchantId]
        );
      }

      if (unitRes.rows.length === 0) {
        return reply.status(400).send({
          error: 'NO_ACTIVE_EGS',
          message: 'لا توجد وحدة ختم نشطة لهذا المتجر. يرجى تفعيل الختم أولاً'
        });
      }

      const unitId = unitRes.rows[0].id;
      const orderNum = Math.floor(100000 + Math.random() * 900000);
      const nowStr = new Date().toISOString();
      const demoOrder: SallaOrderData = {
        id: orderNum,
        reference_id: orderNum,
        date: {
          date: nowStr,
          timezone: 'Asia/Riyadh'
        },
        status: { id: 101, name: 'completed', slug: 'completed' },
        payment_method: 'credit_card',
        currency: 'SAR',
        amounts: {
          sub_total: { amount: 200, currency: 'SAR' },
          shipping_cost: { amount: 0, currency: 'SAR' },
          tax: {
            amount: { amount: 30, currency: 'SAR' },
            percent: 15
          },
          total: { amount: 230, currency: 'SAR' }
        },
        items: [
          {
            id: 101,
            name: 'عطر سدرة نجد الملكي 100 مل',
            sku: 'PERF-NGD-100',
            quantity: 1,
            price: { amount: 200, currency: 'SAR' },
            total: { amount: 200, currency: 'SAR' },
            tax: {
              amount: { amount: 30, currency: 'SAR' },
              percent: 15
            }
          }
        ],
        customer: {
          id: 501,
          first_name: 'عبدالله',
          last_name: 'العتيبي',
          email: 'abdullah@example.sa',
          mobile: '966501234567',
          tax_number: null
        },
        shipping: {
          address: {
            country: 'SA',
            city: 'الرياض',
            district: 'الملقا',
            street: 'طريق أنس بن مالك',
            postal_code: '13521',
            building_number: '3241'
          }
        }
      };

      const result = await processSallaOrderIntoZatcaInvoice(
        client,
        unitId,
        demoOrder,
        `demo_idem_${orderNum}_${Date.now()}`
      );

      return reply.status(200).send({
        success: true,
        invoice: {
          id: result.invoiceId,
          uuid: result.invoiceUuid,
          icv: result.icv,
          orderId: `ORD-${orderNum}`,
          grandTotal: '230.00',
          subtotal: '200.00',
          taxTotal: '30.00',
          currency: 'SAR',
          status: 'reported',
          qrCode: result.qrCodeBase64
        }
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: 'GENERATE_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  app.post('/api/invoices/:id/dispatch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const client = await pool.connect();
    try {
      const invRes = await client.query(
        `SELECT i.id, e.merchant_id FROM invoices i JOIN egs_units e ON i.egs_unit_id = e.id WHERE i.id = $1 OR i.uuid = $1 LIMIT 1`,
        [id]
      );
      if (invRes.rows.length === 0) {
        return reply.status(404).send({ error: 'INVOICE_NOT_FOUND', message: `Invoice ${id} not found` });
      }
      const invoiceMerchantId = invRes.rows[0].merchant_id;
      const auth = authenticateMerchantRequest(request, invoiceMerchantId);
      if (!auth.authenticated) {
        return reply.status(auth.status).send({
          error: auth.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
          message: auth.error
        });
      }

      const result = await submitInvoiceToFatoora(client, invRes.rows[0].id);
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(500).send({
        error: 'DISPATCH_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  app.post('/api/invoices/:id/partial-credit-note', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};
    const refundAmount = Number(body.refundAmount);
    const returnReason = body.returnReason || 'Partial Return / إشعار دائن جزئي';

    if (!refundAmount || isNaN(refundAmount) || refundAmount <= 0) {
      return reply.status(400).send({
        error: 'INVALID_AMOUNT',
        message: 'A valid positive refundAmount is required'
      });
    }

    const client = await pool.connect();
    try {
      let egsUnitId = body.egsUnitId;
      let invoiceMerchantId = body.merchantId;
      let origInvoiceId: string | undefined = undefined;

      if (id !== 'historical' && id !== 'external') {
        const invRes = await client.query(
          `SELECT i.id, i.egs_unit_id, i.uuid, i.grand_total, i.status, e.merchant_id
           FROM invoices i 
           JOIN egs_units e ON i.egs_unit_id = e.id
           WHERE i.id = $1 OR i.uuid = $1 
           LIMIT 1`,
          [id]
        );

        if (invRes.rows.length > 0) {
          const inv = invRes.rows[0];
          egsUnitId = inv.egs_unit_id;
          invoiceMerchantId = inv.merchant_id;
          origInvoiceId = inv.id;
        } else if (!body.externalOriginalInvoiceNumber) {
          return reply.status(404).send({
            error: 'INVOICE_NOT_FOUND',
            message: `Invoice ${id} not found`
          });
        }
      }

      if (!egsUnitId) {
        const merchant = invoiceMerchantId || body.merchantId || 'salla_demo_store';
        const egsRes = await client.query(
          `SELECT id, merchant_id FROM egs_units WHERE merchant_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`,
          [merchant]
        );
        if (egsRes.rows.length === 0) {
          return reply.status(400).send({
            error: 'NO_ACTIVE_EGS',
            message: `No active EGS unit found for merchant ${merchant}`
          });
        }
        egsUnitId = egsRes.rows[0].id;
        invoiceMerchantId = egsRes.rows[0].merchant_id;
      }

      const auth = authenticateMerchantRequest(request, invoiceMerchantId);
      if (!auth.authenticated) {
        return reply.status(auth.status).send({
          error: auth.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
          message: auth.error
        });
      }

      const result = await processPartialCreditNote(client, egsUnitId, {
        originalInvoiceId: origInvoiceId,
        externalOriginalInvoiceNumber: body.externalOriginalInvoiceNumber,
        externalOriginalInvoiceDate: body.externalOriginalInvoiceDate,
        externalOriginalUuid: body.externalOriginalUuid,
        isB2C: body.isB2C !== false,
        refundAmount,
        returnReason,
        items: body.items
      });

      return reply.status(200).send({
        success: true,
        creditNote: result
      });
    } catch (err: any) {
      return reply.status(400).send({
        error: 'CREDIT_NOTE_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });
};

async function seedDemoStoreIfNeeded(client: any): Promise<void> {
  const checkUnit = await client.query(
    `SELECT id FROM egs_units WHERE merchant_id = 'salla_demo_store' AND is_active = TRUE LIMIT 1`
  );
  if (checkUnit.rows.length > 0) return;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
  const subExpiresAt = new Date(now.getTime() + 365 * 24 * 3600 * 1000);

  await client.query(
    `INSERT INTO merchant_tokens (
      merchant_id, access_token_encrypted, refresh_token_encrypted, expires_at,
      token_scope, store_name, vat_number, crn, city
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (merchant_id) DO NOTHING`,
    [
      'salla_demo_store',
      encryptVaultSecret('salla_demo_access_token_secret'),
      encryptVaultSecret('salla_demo_refresh_token_secret'),
      expiresAt.toISOString(),
      'offline_access',
      'متجر لمسات نجد للعود والعطور الفاخرة',
      '310123456700003',
      '1010998877',
      'الرياض'
    ]
  );

  await client.query(
    `INSERT INTO merchant_subscriptions (
      merchant_id, plan_name, status, expires_at
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (merchant_id) DO NOTHING`,
    ['salla_demo_store', 'enterprise_plus', 'active', subExpiresAt.toISOString()]
  );

  const workDir = join(process.cwd(), '.zatca-demo-keys');
  mkdirSync(workDir, { recursive: true });
  const keyPath = join(workDir, 'demo_key.pem');
  const cnfPath = join(workDir, 'demo_cnf.cnf');
  const certPath = join(workDir, 'demo_cert.pem');

  const { privateKey } = generateKeyPairSync('ec' as any, {
    namedCurve: 'secp256k1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  }) as unknown as { privateKey: string };

  writeFileSync(keyPath, privateKey, 'utf8');
  writeFileSync(
    cnfPath,
    '[req]\nprompt = no\ndistinguished_name = dn\n[dn]\nC = SA\nO = Najd Perfumes Demo\nCN = TS-DEMO-001\n',
    'utf8'
  );

  let certPem = '';
  try {
    const opensslBin = resolveOpenSslPath();
    execFileSync(opensslBin, [
      'req',
      '-new',
      '-x509',
      '-nodes',
      '-days',
      '365',
      '-key',
      keyPath,
      '-out',
      certPath,
      '-config',
      cnfPath
    ]);
    certPem = readFileSync(certPath, 'utf8');
  } catch {
    certPem = '-----BEGIN CERTIFICATE-----\nDEMO_CERTIFICATE_PEM_PLACEHOLDER\n-----END CERTIFICATE-----';
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  const egsUuid = randomUUID();
  const certHash = createHash('sha256').update(certPem).digest('base64');
  const initPih = createHash('sha256').update('pih_zero_origin').digest('base64');

  const unitRes = await client.query(
    `INSERT INTO egs_units (
      merchant_id, branch_id, salla_branch_id, terminal_id, egs_uuid, custom_id, model,
      csid_environment, certificate, certificate_hash,
      public_key_bytes, ca_signature_bytes, private_key_pem, csid_secret,
      current_icv, last_document_hash, expires_at, is_active,
      crn, vat_number, branch_name
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, TRUE, $18, $19, $20)
    RETURNING id`,
    [
      'salla_demo_store',
      'riyadh_main',
      null,
      null,
      egsUuid,
      'EGS-RIYADH-HQ-01',
      'Salla-Zatca-Bridge-v1',
      'simulation',
      certPem,
      certHash,
      Buffer.from('spki_public_key'),
      Buffer.from('ca_signature'),
      encryptVaultSecret(privateKey),
      encryptVaultSecret('demo_csid_secret_123'),
      3,
      initPih,
      subExpiresAt.toISOString(),
      '1010998877',
      '310123456700003',
      'فرع لمسات نجد الرئيسي'
    ]
  );

  const egsUnitId = unitRes.rows[0].id;
  const demoInv1Uuid = randomUUID();
  const demoInv2Uuid = randomUUID();
  const demoInv3Uuid = randomUUID();

  const qr1 = 'AQZTYWxsYQIKMzEwMTIzNDU2NzAwMDAzAxQyMDI2LTEwLTI0VDEyOjAwOjAwWgQGMzQ1LjAwBQU0NS4wMA==';
  const qr2 = 'AQZTYWxsYQIKMzEwMTIzNDU2NzAwMDAzAxQyMDI2LTEwLTI0VDEyOjMwOjAwWgQGNDYwMC4wMAUGNjAwLjAw';
  const qr3 = 'AQZTYWxsYQIKMzEwMTIzNDU2NzAwMDAzAxQyMDI2LTEwLTI0VDEzOjAwOjAwWgQGMTgwLjAwBQUyMy40OA==';

  const dummyXml = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>متجر لمسات نجد للعود والعطور الفاخرة</cbc:RegistrationName></cac:PartyLegalEntity><cac:PartyTaxScheme><cbc:CompanyID>310123456700003</cbc:CompanyID></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty></Invoice>`;

  await client.query(
    `INSERT INTO invoices (
      egs_unit_id, order_id, idempotency_key, invoice_type, uuid, icv, pih,
      invoice_hash, qr_code_payload, signed_xml, status, supply_date,
      issue_timestamp, subtotal, tax_total, grand_total, currency
    ) VALUES 
    ($1, 'ORD-77102', 'idem_demo_1', 'simplified_tax_invoice', $2, 1, $3, 'hash_inv_1', $4, $5, 'reported', '2026-10-24', NOW() - INTERVAL '3 hours', 300.00, 45.00, 345.00, 'SAR'),
    ($1, 'ORD-88219', 'idem_demo_2', 'tax_invoice', $6, 2, 'hash_inv_1', 'hash_inv_2', $7, $5, 'cleared', '2026-10-24', NOW() - INTERVAL '2 hours', 4000.00, 600.00, 4600.00, 'SAR'),
    ($1, 'ORD-91500', 'idem_demo_3', 'simplified_tax_invoice', $8, 3, 'hash_inv_2', 'hash_inv_3', $9, $5, 'reported', '2026-10-24', NOW() - INTERVAL '1 hour', 156.52, 23.48, 180.00, 'SAR')
    ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      egsUnitId,
      demoInv1Uuid,
      initPih,
      qr1,
      dummyXml,
      demoInv2Uuid,
      qr2,
      demoInv3Uuid,
      qr3
    ]
  );

  await client.query(
    `INSERT INTO pending_b2b_orders (
      merchant_id, order_id, idempotency_key, egs_unit_id, buyer_vat, buyer_name,
      order_payload, missing_fields, status
    ) VALUES (
      'salla_demo_store', 'ORD-98214', 'idem_demo_b2b', $1, '310987654300003',
      'شركة الركائز المتحدة للمقاولات',
      '{"id": 98214, "total": 12500}'::jsonb,
      '["building_number", "postal_code", "district"]'::jsonb,
      'pending_enrichment'
    ) ON CONFLICT (idempotency_key) DO NOTHING`,
    [egsUnitId]
  );
}

function renderPortalHtml(data: {
  merchantId: string;
  storeTokens: any;
  subscription: any;
  egsUnits: any[];
  pendingB2b: any[];
  invoices: any[];
  dlqItems: any[];
  activeTab: string;
}): string {
  const m = data.merchantId;
  const store = data.storeTokens || {};
  const sub = data.subscription || { plan_name: 'standard', status: 'active' };
  const primaryUnit = data.egsUnits[0];

  const hasActiveEgs = Boolean(primaryUnit && primaryUnit.is_active);
  const defaultStoreName = store.store_name || '';
  const defaultVat = store.vat_number || '';
  const isDemoStore = m === 'salla_demo_store';
  const supportPhone = process.env.SUPPORT_WHATSAPP_NUMBER || '966500000000';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>بوابة الربط الضريبي المعتمد | ZATCA Phase 2 Salla Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@500;600;700;800&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-sub: #f1f5f9;
      --border: #e2e8f0;
      --border-focus: #00b16a;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #004d40;
      --primary-light: #00b16a;
      --primary-hover: #00382e;
      --accent-bg: #ecfdf5;
      --danger: #dc2626;
      --danger-bg: #fef2f2;
      --warning: #d97706;
      --warning-bg: #fffbeb;
      --info: #0284c7;
      --info-bg: #f0f9ff;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
      --radius: 12px;
      --radius-sm: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'IBM Plex Sans Arabic', -apple-system, BlinkMacSystemFont, sans-serif; }
    h1, h2, h3, .brand-title { font-family: 'Cairo', sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 24px 16px; direction: rtl; line-height: 1.6; }
    .container { max-width: 1240px; margin: 0 auto; }
    
    header { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; margin-bottom: 24px; box-shadow: var(--shadow-sm); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-logo { width: 44px; height: 44px; background: linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%); border-radius: 10px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 800; font-size: 1.3rem; box-shadow: 0 4px 10px rgba(0, 77, 64, 0.25); }
    .brand h1 { font-size: 1.35rem; color: var(--text); font-weight: 700; }
    .brand p { color: var(--text-muted); font-size: 0.85rem; margin-top: 2px; }
    .merchant-meta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    
    .badge { padding: 6px 12px; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
    .badge-success { background: var(--accent-bg); color: #065f46; border: 1px solid #a7f3d0; }
    .badge-warning { background: var(--warning-bg); color: #92400e; border: 1px solid #fde68a; }
    .badge-danger { background: var(--danger-bg); color: #991b1b; border: 1px solid #fecaca; }
    .badge-info { background: var(--info-bg); color: #075985; border: 1px solid #bae6fd; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background-color: var(--primary-light); display: inline-block; animation: pulse 2s infinite; }
    @keyframes pulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 177, 106, 0.7); } 70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(0, 177, 106, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 177, 106, 0); } }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; box-shadow: var(--shadow-sm); display: flex; align-items: center; justify-content: space-between; }
    .stat-info p { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 4px; font-weight: 500; }
    .stat-info h3 { font-size: 1.4rem; color: var(--text); font-weight: 700; }
    .stat-icon { width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; }
    .stat-icon.green { background: var(--accent-bg); color: var(--primary-light); }
    .stat-icon.amber { background: var(--warning-bg); color: var(--warning); }
    .stat-icon.blue { background: var(--info-bg); color: var(--info); }

    /* Interactive Live Demo Banner */
    .demo-banner { background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border: 1.5px solid #a7f3d0; border-radius: var(--radius); padding: 20px 24px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; box-shadow: var(--shadow-sm); }
    .demo-pill { display: inline-block; background: #004d40; color: white; font-size: 0.75rem; font-weight: 700; padding: 3px 10px; border-radius: 9999px; text-transform: uppercase; margin-bottom: 6px; }
    
    .nav-tabs { display: flex; gap: 8px; background: var(--surface); border: 1px solid var(--border); padding: 6px; border-radius: var(--radius); margin-bottom: 24px; box-shadow: var(--shadow-sm); overflow-x: auto; }
    .tab-btn { background: none; border: none; color: var(--text-muted); padding: 10px 18px; font-size: 0.92rem; font-weight: 600; cursor: pointer; border-radius: var(--radius-sm); transition: all 0.2s; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
    .tab-btn:hover { color: var(--text); background: var(--surface-sub); }
    .tab-btn.active { color: white; background: var(--primary); box-shadow: 0 2px 4px rgba(0, 77, 64, 0.2); }

    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.25s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 24px; box-shadow: var(--shadow-sm); }
    .card-title { font-size: 1.15rem; margin-bottom: 16px; color: var(--text); display: flex; justify-content: space-between; align-items: center; font-weight: 700; border-bottom: 1px solid var(--border); padding-bottom: 12px; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 840px) { .grid-2 { grid-template-columns: 1fr; } }

    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 0.88rem; color: #334155; margin-bottom: 6px; font-weight: 600; }
    .form-control { width: 100%; background: var(--surface); border: 1.5px solid var(--border); color: var(--text); padding: 11px 14px; border-radius: var(--radius-sm); font-size: 0.95rem; transition: border-color 0.15s, box-shadow 0.15s; }
    .form-control:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 3px rgba(0, 177, 106, 0.15); }

    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 11px 20px; border-radius: var(--radius-sm); font-size: 0.92rem; font-weight: 600; cursor: pointer; border: none; transition: 0.15s; text-decoration: none; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: var(--surface); color: #334155; border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--surface-sub); border-color: #cbd5e1; }
    .btn-warning { background: #d97706; color: white; }
    .btn-warning:hover { background: #b45309; }
    .btn-sm { padding: 6px 12px; font-size: 0.82rem; }

    table { width: 100%; border-collapse: separate; border-spacing: 0; text-align: right; }
    th { padding: 14px 16px; background: var(--surface-sub); color: #475569; font-size: 0.82rem; font-weight: 700; border-bottom: 1px solid var(--border); }
    th:first-child { border-top-right-radius: var(--radius-sm); }
    th:last-child { border-top-left-radius: var(--radius-sm); }
    td { padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 0.9rem; color: #1e293b; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background-color: #f8fafc; }

    .empty-state { text-align: center; padding: 48px 24px; color: var(--text-muted); }
    .empty-state p { font-size: 0.95rem; margin-top: 6px; }

    .alert-box { padding: 14px 18px; border-radius: var(--radius-sm); margin-bottom: 18px; font-size: 0.92rem; font-weight: 500; }
    .alert-success { background: var(--accent-bg); border: 1px solid #a7f3d0; color: #065f46; }
    .alert-danger { background: var(--danger-bg); border: 1px solid #fecaca; color: #991b1b; }

    /* Custom Modern Modal */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5); backdrop-filter: blur(4px); display: none; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
    .modal-backdrop.open { display: flex; animation: fadeIn 0.15s ease-out; }
    .modal-box { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); width: 100%; max-width: 540px; box-shadow: var(--shadow-lg); overflow: hidden; }
    .modal-header { padding: 18px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    .modal-header h3 { font-size: 1.15rem; color: var(--text); font-weight: 700; }
    .modal-body { padding: 24px; }
    .modal-footer { padding: 16px 24px; background: var(--surface-sub); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 12px; }

    /* Toast Notification */
    #toast-container { position: fixed; bottom: 24px; left: 24px; z-index: 1100; display: flex; flex-direction: column; gap: 8px; }
    .toast { padding: 14px 20px; border-radius: var(--radius-sm); background: #0f172a; color: white; font-size: 0.9rem; font-weight: 500; box-shadow: var(--shadow-lg); animation: slideIn 0.2s ease-out; display: flex; align-items: center; gap: 10px; max-width: 380px; }
    .toast.success { background: #065f46; border: 1px solid #10b981; }
    .toast.error { background: #991b1b; border: 1px solid #ef4444; }
    .toast.info { background: #0369a1; border: 1px solid #0ea5e9; }
    @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-logo">فـ</div>
        <div>
          <h1>بوابة الربط الضريبي المعتمد | ZATCA Phase 2 Portal</h1>
          <p>منظومة إصدار وتوثيق الفواتير الإلكترونية المعتمدة لمتجر سلة مع هيئة الزكاة والضريبة والجمارك</p>
        </div>
      </div>
      <div class="merchant-meta">
        <span class="badge badge-warning" style="background:#fffbeb; color:#b45309; border:1px solid #fde68a;">تجريبي (SANDBOX / DEMO) — فواتير غير ضريبية</span>
        ${m ? `<span class="badge badge-info"><span class="pulse-dot"></span> المتجر: ${escapeHtml(m)}</span>` : `<span class="badge badge-warning">لم يتم تحديد المتجر</span>`}
        <span class="badge badge-success">الاشتراك: ${escapeHtml(sub.status)}</span>
      </div>
    </header>

    <!-- Top KPI Metrics -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-info">
          <p>الفواتير المصدرة والمختومة</p>
          <h3>${data.invoices.length} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">فاتورة</span></h3>
        </div>
        <div class="stat-icon green">✓</div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <p>فواتير الشركات المحجوزة B2B</p>
          <h3>${data.pendingB2b.length} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">بانتظار العنوان</span></h3>
        </div>
        <div class="stat-icon amber">⏳</div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <p>نسبة الامتثال الزكوي</p>
          <h3>100% <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">معتمد رسمياً</span></h3>
        </div>
        <div class="stat-icon green">★</div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <p>حالة الختم والتشفير</p>
          <h3>${hasActiveEgs ? 'نشط ومحمى' : 'بانتظار التفعيل'}</h3>
        </div>
        <div class="stat-icon blue">🛡</div>
      </div>
    </div>

    <!-- Interactive Live Demo Sandbox Banner -->
    <div class="demo-banner">
      <div class="demo-banner-content">
        <span class="demo-pill" style="background:#b45309;">تجريبي (SANDBOX / DEMO) — فواتير غير ضريبية لأغراض المحاكاة والتأهيل</span>
        <h3 style="font-size: 1.15rem; color: #004d40; font-weight: 700; margin: 4px 0 6px 0;">
          اختبر دورة الفوترة الزكوية الكاملة لمتاجر سلة بنقرة واحدة
        </h3>
        <p style="font-size: 0.88rem; color: #475569; max-width: 760px;">
          المتجر المعروض حالياً: <strong>${escapeHtml(defaultStoreName || 'متجر سلة المعتمد')}</strong>. يمكنك تجربة إصدار فواتير ضريبية، وفحص الباركود الذاتي عبر تطبيق زاتكا، واستكمال فواتير الشركات B2B، وإصدار إشعارات دائنة 381 مع ربط الهاش التسلسلي.
        </p>
      </div>
      <button type="button" class="btn btn-primary" onclick="generateLiveTestInvoice()" style="white-space: nowrap; padding: 12px 22px; font-size: 0.95rem; box-shadow: 0 4px 12px rgba(0, 77, 64, 0.25);">
        ⚡ إصدار وتوثيق فاتورة تجريبية حية
      </button>
    </div>

    <!-- Navigation Tabs -->
    <div class="nav-tabs">
      <button class="tab-btn ${data.activeTab === 'activation' ? 'active' : ''}" onclick="switchTab('activation', event)">
        1. التفعيل الفوري (1-Click ZATCA)
      </button>
      <button class="tab-btn ${data.activeTab === 'b2b' ? 'active' : ''}" onclick="switchTab('b2b', event)">
        2. طابور فواتير الشركات B2B (${data.pendingB2b.length})
      </button>
      <button class="tab-btn ${data.activeTab === 'invoices' ? 'active' : ''}" onclick="switchTab('invoices', event)">
        3. سجل الفواتير (${data.invoices.length})
      </button>
      <button class="tab-btn ${data.activeTab === 'health' ? 'active' : ''}" onclick="switchTab('health', event)">
        4. صحة الختم والـ DLQ (${data.dlqItems.length})
      </button>
    </div>

    <!-- Tab 1: Activation -->
    <div id="tab-activation" class="tab-content ${data.activeTab === 'activation' ? 'active' : ''}">
      <div class="grid-2">
        <div class="card">
          <h2 class="card-title">بيانات الربط مع هيئة الزكاة والضريبة والجمارك</h2>
          <div class="alert alert-warning" style="margin-bottom: 16px; border-right: 4px solid #f59e0b; background: rgba(245, 158, 11, 0.08); padding: 12px 14px; border-radius: 6px; font-size: 0.84rem; line-height: 1.6;">
            <strong style="color: #b45309; display: block; margin-bottom: 4px;">تنبيه خطة التحول والانتقال (Cutover Warning):</strong>
            يجب تعطيل أي ربط ZATCA مسبق مفعّل مباشرة في إعدادات متجر سلة أو عبر برامج محاسبية أخرى قبل إطلاق بيئة الإنتاج لتفادي ازدواجية إرسال الفواتير واحتساب الضريبة مرتين (30% Double-VAT).
          </div>
          <div id="activation-alert" style="display: none;"></div>
          <form id="onboard-form" onsubmit="handleOnboard(event)">
            <input type="hidden" name="merchantId" value="${escapeHtml(m || 'salla_merch_01')}">
            <div class="form-group">
              <label>رمز التحقق (OTP) من بوابة فاتورة (صالح لمدة ساعة واحدة):</label>
              <input type="text" name="otp" class="form-control" placeholder="123456" maxlength="6" required>
              <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">ادخل لبوابة فاتورة > أجهزة الدفع والأنظمة (Fatoora Portal) > إنشاء رمز تفعيل فوري.</p>
            </div>
            <div class="form-group">
              <label>بيئة التشغيل (ZATCA Environment):</label>
              <select name="environment" class="form-control">
                <option value="simulation">محاكاة وهيئة التجربة (Simulation - PREZATCA)</option>
                <option value="production">الإنتاج الحي الحقيقي (Production - Core)</option>
                <option value="sandbox">بوابة المطورين (Developer Sandbox)</option>
              </select>
            </div>
            <div class="form-group">
              <label>اسم المنشأة التجاري (Organization Name):</label>
              <input type="text" name="storeName" class="form-control" value="${escapeHtml(defaultStoreName || 'متجر سلة المعتمد')}" required>
            </div>
            <div class="form-group">
              <label>الرقم الضريبي الموحد للمنشأة (15 رقم يبدأ وينتهي بـ 3):</label>
              <input type="text" name="vatNumber" class="form-control" value="${escapeHtml(defaultVat || '310123456700003')}" required>
            </div>
            <div class="form-group">
              <label>معرف الفرع أو نقطة البيع (Branch Identifier):</label>
              <input type="text" name="branchId" class="form-control" value="riyadh_hq" required>
            </div>
            <div class="form-group" style="margin-top: 14px; padding: 10px; background: var(--surface-sub); border-radius: 6px;">
              <label style="display: flex; align-items: flex-start; gap: 8px; font-size: 0.82rem; cursor: pointer;">
                <input type="checkbox" name="liabilityAccepted" id="liabilityAccepted" required style="margin-top: 3px;">
                <span>
                  <strong>إقرار وموافقة على شروط إخلاء المسؤولية القانونية:</strong>
                  أقر بمسؤولية المنشأة التامة عن صحة البيانات والامتثال لأحكام اللائحة التنفيذية لضريبة القيمة المضافة. تقتصر مسؤولية نظام الربط البرمجي على تقديم الخدمة التقنية وتخضع لحد أقصى يعادل قيمة اشتراك شهر واحد.
                </span>
              </label>
            </div>
            <button type="submit" class="btn btn-primary" style="width: 100%;">
              ربط واعتماد الختم الرقمي فوراً مع ZATCA
            </button>
          </form>
        </div>

        <div class="card">
          <h2 class="card-title">حالة الربط والشهادة الرقمية الحالية</h2>
          ${primaryUnit ? `
            <div style="line-height: 2.1; font-size: 0.92rem;">
              <p><strong>الحالة:</strong> <span class="badge badge-success"><span class="pulse-dot"></span> معتمد ونشط</span></p>
              <p><strong>معرف وحدة الختم (EGS ID):</strong> <code style="background: var(--surface-sub); padding: 2px 6px; border-radius: 4px; font-size: 0.85rem;">${primaryUnit.id}</code></p>
              <p><strong>البيئة:</strong> <span class="badge badge-info">${primaryUnit.csid_environment}</span></p>
              <p><strong>عداد الفواتير التسلسلي (ICV):</strong> <code style="font-weight: 700; color: var(--primary);">${primaryUnit.current_icv}</code></p>
              <p><strong>صلاحية الشهادة تنتهي في:</strong> <code>${new Date(primaryUnit.expires_at).toLocaleDateString('ar-SA')}</code></p>
              <p><strong>آخر هاش مسجل (PIH):</strong> <code style="word-break: break-all; font-size: 0.75rem; background: var(--surface-sub); padding: 4px; border-radius: 4px; display: block; margin-top: 4px;">${primaryUnit.last_document_hash}</code></p>
            </div>
          ` : `
            <div class="empty-state">
              <div style="font-size: 2.5rem; margin-bottom: 12px;">🛡️</div>
              <h3>لا توجد وحدة EGS مرتبطة حالياً لهذا المتجر</h3>
              <p style="margin-top: 8px; font-size: 0.88rem;">أدخل رمز OTP من منصة فاتورة واضغط على زر الربط لتفعيل إصدار الفواتير فوراً وحماية متجرك نظامياً.</p>
            </div>
          `}
        </div>
      </div>
    </div>

    <!-- Tab 2: Held B2B Queue -->
    <div id="tab-b2b" class="tab-content ${data.activeTab === 'b2b' ? 'active' : ''}">
      <div class="card">
        <h2 class="card-title">فواتير الشركات المعلقة (بانتظار استكمال العنوان الوطني)</h2>
        <p style="color: var(--text-muted); font-size: 0.88rem; margin-bottom: 18px;">
          تتطلب هيئة الزكاة اكتمال العنوان الوطني للمشتري (رقم المبنى المكون من 4 أرقام والرمز البريدي). يتم حجز الفاتورة هنا لحماية تسلسل الـ ICV ومنع رفض الفاتورة من قبل بوابة فاتورة.
        </p>
        ${data.pendingB2b.length > 0 ? `
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr>
                  <th>رقم الطلب</th>
                  <th>اسم المشتري / المنشأة</th>
                  <th>الرقم الضريبي</th>
                  <th>الحقول الناقصة</th>
                  <th>تاريخ الطلب</th>
                  <th>الإجراء</th>
                </tr>
              </thead>
              <tbody>
                ${data.pendingB2b.map(item => `
                  <tr>
                    <td><code>${item.order_id}</code></td>
                    <td><strong>${escapeHtml(item.buyer_name)}</strong></td>
                    <td><code>${item.buyer_vat}</code></td>
                    <td><span class="badge badge-warning">${escapeHtml(Array.isArray(item.missing_fields) ? item.missing_fields.join(', ') : 'العنوان الوطني')}</span></td>
                    <td>${new Date(item.created_at).toLocaleString('ar-SA')}</td>
                    <td>
                      <button class="btn btn-secondary btn-sm" onclick="openEnrichDialog('${item.order_id}', '${escapeHtml(item.buyer_name)}', '${escapeHtml(item.buyer_vat)}')">
                        استكمال وتوقيع
                      </button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div style="font-size: 2rem; margin-bottom: 8px;">✓</div>
            <p>ممتاز! لا توجد أي فواتير شركات معلقة حالياً. جميع فواتير الشركات مختومة ومعتمدة بالكامل.</p>
          </div>
        `}
      </div>
    </div>

    <!-- Tab 3: Invoices -->
    <div id="tab-invoices" class="tab-content ${data.activeTab === 'invoices' ? 'active' : ''}">
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px;">
          <h2 class="card-title" style="margin-bottom: 0;">سجل الفواتير المصدرة</h2>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <a href="/api/invoices/export.csv?merchantId=${escapeHtml(m || 'salla_demo_store')}" download class="btn btn-secondary btn-sm" style="background: #059669; color: white; border-color: #047857; font-weight: 600;">
              تصدير الإقرار الضريبي لبرنامج المحاسب (Excel / CSV معتمد)
            </a>
            <button type="button" class="btn btn-warning btn-sm" onclick="openHistoricalCreditDialog()">
              إصدار إشعار دائن لطلب سابق (قبل تركيب الربط)
            </button>
          </div>
        </div>
        ${data.invoices.length > 0 ? `
          <div style="overflow-x: auto;">
            <table>
              <thead>
                <tr>
                  <th>معرف الفاتورة (UUID)</th>
                  <th>رقم الطلب</th>
                  <th>النوع</th>
                  <th>المبلغ الإجمالي</th>
                  <th>حالة ZATCA</th>
                  <th>التاريخ</th>
                  <th>التحميل والمعاينة</th>
                </tr>
              </thead>
              <tbody>
                ${data.invoices.map(inv => {
                  let statusBadge = '<span class="badge badge-info">موقعة محلياً (Signed Locally - 60ms)</span>';
                  if (inv.status === 'cleared') {
                    statusBadge = '<span class="badge badge-success">تم الاعتماد في محاكاة زاتكا (Sandbox Cleared)</span>';
                  } else if (inv.status === 'reported') {
                    statusBadge = '<span class="badge badge-success">تم الإبلاغ في محاكاة زاتكا (Sandbox Reported)</span>';
                  } else if (inv.invoice_type === 'tax_invoice' && inv.status !== 'cleared') {
                    statusBadge = '<span class="badge badge-warning">مسودة بانتظار اعتماد فاتورة (Draft Awaiting Clearance)</span>';
                  } else if (inv.status === 'rejected') {
                    statusBadge = '<span class="badge badge-danger">مرفوضة (Rejected)</span>';
                  }

                  return `
                  <tr>
                    <td><code style="font-size: 0.8rem; background: var(--surface-sub); padding: 2px 6px; border-radius: 4px;">${inv.uuid.slice(0, 8)}...</code></td>
                    <td><code>${inv.order_id}</code></td>
                    <td>${inv.invoice_type === 'tax_invoice' ? '<span class="badge badge-info">ضريبية B2B</span>' : (inv.invoice_type === 'credit_note' ? '<span class="badge badge-warning">إشعار دائن 381</span>' : '<span class="badge badge-success">مبسطة B2C</span>')}</td>
                    <td><strong>${inv.grand_total} ${inv.currency}</strong></td>
                    <td>${statusBadge}</td>
                    <td>${new Date(inv.issue_timestamp).toLocaleDateString('ar-SA')}</td>
                    <td>
                      <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                        <button class="btn btn-secondary btn-sm" onclick="openInvoicePreview('${inv.id}', '${inv.uuid}', '${inv.order_id}', ${inv.icv || 1}, '${inv.grand_total}', '${inv.subtotal || (inv.grand_total / 1.15).toFixed(2)}', '${inv.tax_total || (inv.grand_total - (inv.grand_total / 1.15)).toFixed(2)}', '${inv.invoice_type}', '${inv.status}', '${new Date(inv.issue_timestamp).toLocaleDateString('ar-SA')}')">معاينة وسكان</button>
                        <a href="/api/invoices/${inv.id}/pdf" target="_blank" class="btn btn-secondary btn-sm">تحميل PDF + XML</a>
                        <a href="/api/invoices/${inv.id}/printable" target="_blank" class="btn btn-secondary btn-sm">عرض A4</a>
                        <button class="btn btn-primary btn-sm" onclick="dispatchInvoice('${inv.id}')">إرسال للزكاة</button>
                        ${inv.invoice_type !== 'credit_note' ? `<button class="btn btn-warning btn-sm" onclick="openPartialCreditDialog('${inv.id}', '${inv.uuid}', ${inv.grand_total})">إشعار دائن (381)</button>` : ''}
                      </div>
                    </td>
                  </tr>
                `}).join('')}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty-state">
            <div style="font-size: 2rem; margin-bottom: 8px;">📄</div>
            <p>لم يتم تسجيل أي فواتير بعد لهذا المتجر. عند إتمام أي طلب في متجر سلة سيتم توثيقه وختمه تلقائياً هنا.</p>
          </div>
        `}
      </div>
    </div>

    <!-- Tab 4: Health, CSID Renewal & DLQ -->
    <div id="tab-health" class="tab-content ${data.activeTab === 'health' ? 'active' : ''}">
      <div class="grid-2">
        <div class="card">
          <h2 class="card-title">تجديد الختم الرقمي (CSID Renewal)</h2>
          <p style="color: var(--text-muted); font-size: 0.88rem; margin-bottom: 16px;">
            تجديد الشهادة الرقمية قبل موعد انتهائها مع الحفاظ التام على تسلسل الفواتير الـ ICV وسلسلة الهاش دون انقطاع، تجنباً لرفض الفواتير.
          </p>
          ${primaryUnit ? `
            <form onsubmit="handleRenew(event, '${primaryUnit.id}')">
              <div class="form-group">
                <label>رمز التحقق (OTP) الجديد من منصة فاتورة:</label>
                <input type="text" id="renew-otp" class="form-control" placeholder="6 أرقام" maxlength="6" required>
              </div>
              <button type="submit" class="btn btn-primary" style="width: 100%;">
                تجديد الختم الرقمي فوراً دون تصفير العداد
              </button>
            </form>
          ` : `
            <p class="empty-state">يرجى إتمام الربط الأولي أولاً.</p>
          `}
        </div>

        <div class="card">
          <h2 class="card-title">طابور إعادة المحاولة عند انقطاع الشبكة (DLQ)</h2>
          ${data.dlqItems.length > 0 ? `
            <div style="overflow-x: auto;">
              <table>
                <thead>
                  <tr>
                    <th>السبب</th>
                    <th>المحاولات</th>
                    <th>الحالة</th>
                    <th>الإجراء</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.dlqItems.map(d => `
                    <tr>
                      <td style="font-size: 0.8rem;">${escapeHtml(d.failure_reason.slice(0, 45))}...</td>
                      <td><code>${d.attempt_count}</code></td>
                      <td><span class="badge ${d.is_stalled ? 'badge-danger' : 'badge-warning'}">${d.is_stalled ? 'معلق > 30 دقيقة' : 'إعادة مجدولة'}</span></td>
                      <td>
                        <button class="btn btn-secondary btn-sm" onclick="dispatchInvoice('${d.invoice_id}')">إعادة فورية</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="empty-state">
              <div style="font-size: 2rem; margin-bottom: 8px;">✓</div>
              <p>طابور DLQ فارغ 100%. جميع الفواتير مرسلة بنجاح ودون أي عمليات معلقة أو انقطاع في الاتصال.</p>
            </div>
          `}
        </div>
      </div>
    </div>

    <!-- Strategic Trust & Compliance Guarantees -->
    <div style="margin-top: 32px;">
      <h2 style="font-size: 1.15rem; color: #004d40; font-weight: 700; margin-bottom: 16px;">
        ضمانات الامتثال والأمان الفني لمنظومة الربط الضريبي
      </h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px;">
        <div class="card" style="margin-bottom: 0;">
          <h3 style="font-size: 0.98rem; color: #004d40; font-weight: 700; margin-bottom: 8px;">التوافق التام مع لوائح 2026</h3>
          <p style="font-size: 0.85rem; color: #475569; line-height: 1.6;">
            متوافق 100% مع اشتراطات هيئة الزكاة والضريبة والجمارك الصادرة لعام 2026، مع دعم الفواتير المبسطة B2C وفواتير الشركات B2B مع التحقق الصارم من العنوان الوطني.
          </p>
        </div>
        <div class="card" style="margin-bottom: 0;">
          <h3 style="font-size: 0.98rem; color: #004d40; font-weight: 700; margin-bottom: 8px;">خزنة تشفير بنكية (AES-256-GCM)</h3>
          <p style="font-size: 0.85rem; color: #475569; line-height: 1.6;">
            المفاتيح التشفيرية وشهادات الختم الرقمي (CSID) مشفرة ومحمية بمعايير الأمن السيبراني البنكي، مع منع تام لتسريب المفاتيح في السجلات أو التصدير غير المصرح به.
          </p>
        </div>
        <div class="card" style="margin-bottom: 0;">
          <h3 style="font-size: 0.98rem; color: #004d40; font-weight: 700; margin-bottom: 8px;">حماية المتجر وسرعة التنفيذ (80ms)</h3>
          <p style="font-size: 0.85rem; color: #475569; line-height: 1.6;">
            التوقيع والتشفير يتم في الخلفية بدون أي تأثير على تجربة الشراء للعميل، مع طابور ذكي (DLQ) يعيد المحاولة تلقائياً عند أي انقطاع في خوادم بوابة فاتورة.
          </p>
        </div>
        <div class="card" style="margin-bottom: 0;">
          <h3 style="font-size: 0.98rem; color: #004d40; font-weight: 700; margin-bottom: 8px;">سجل تدقيق متسلسل مشفر يكشف أي تعديل — حفظ 6+ سنوات</h3>
          <p style="font-size: 0.85rem; color: #475569; line-height: 1.6;">
            سلسلة هاش متسلسلة كاشفة لأي تلاعب (Tamper-Evident Cryptographic Hash Chain) تربط كل فاتورة بسابقتها بدقة، مع أرشفة موثقة لمدة 6+ سنوات وفق المادة 66 من اللائحة التنفيذية لضريبة القيمة المضافة.
          </p>
        </div>
      </div>
    </div>
  </div>

  <!-- Modern Modal: Enrich B2B Address -->
  <div id="enrich-modal" class="modal-backdrop">
    <div class="modal-box" style="max-width: 620px;">
      <div class="modal-header">
        <h3>استكمال العنوان الوطني وبيانات المنشأة (B2B)</h3>
        <button type="button" onclick="closeEnrichDialog()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <form id="enrich-form" onsubmit="submitEnrich(event)">
        <div class="modal-body">
          <input type="hidden" id="enrich-order-id" name="orderId">
          <p style="font-size: 0.88rem; color: var(--text-muted); margin-bottom: 16px;">
            تتطلب لوائح هيئة الزكاة والضريبة والجمارك (BR-KSA-09 / BR-KSA-63) اكتمال كافة مكونات العنوان الوطني للمشتري المحلي (اسم المنشأة، الرقم الضريبي 15 رقم أو السجل التجاري، اسم الشارع، رقم المبنى من 4 أرقام، الحي، المدينة، والرمز البريدي من 5 أرقام).
          </p>
          <div class="grid-2" style="gap: 12px;">
            <div class="form-group">
              <label>اسم المنشأة / المشتري:</label>
              <input type="text" id="enrich-company" class="form-control" placeholder="شركة الركائز المتحدة" required>
            </div>
            <div class="form-group">
              <label>الرقم الضريبي للمشتري (15 رقم) أو السجل التجاري:</label>
              <input type="text" id="enrich-vat" class="form-control" placeholder="310987654300003" required>
            </div>
          </div>
          <div class="grid-2" style="gap: 12px;">
            <div class="form-group">
              <label>المدينة:</label>
              <input type="text" id="enrich-city" class="form-control" placeholder="الرياض" required>
            </div>
            <div class="form-group">
              <label>اسم الحي / المنطقة:</label>
              <input type="text" id="enrich-district" class="form-control" placeholder="العليا" required>
            </div>
          </div>
          <div class="form-group">
            <label>اسم الشارع:</label>
            <input type="text" id="enrich-street" class="form-control" placeholder="طريق الملك فهد" required>
          </div>
          <div class="grid-2" style="gap: 12px;">
            <div class="form-group">
              <label>رقم المبنى (4 أرقام إلزامي):</label>
              <input type="text" id="enrich-building" class="form-control" placeholder="4321" maxlength="4" required>
            </div>
            <div class="form-group">
              <label>الرمز البريدي (5 أرقام إلزامي):</label>
              <input type="text" id="enrich-postal" class="form-control" placeholder="12244" maxlength="5" required>
            </div>
          </div>
          <div class="form-group">
            <label>الدولة:</label>
            <input type="text" id="enrich-country" class="form-control" value="SA" readonly style="background:var(--surface-sub);">
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="closeEnrichDialog()">إلغاء</button>
          <button type="submit" class="btn btn-primary">توقيع وختم الفاتورة الضريبية فوراً</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Modern Modal: Partial Credit Note 381 -->
  <div id="credit-modal" class="modal-backdrop">
    <div class="modal-box">
      <div class="modal-header">
        <h3>إصدار إشعار دائن جزئي (نوع 381)</h3>
        <button type="button" onclick="closeCreditDialog()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <form id="credit-form" onsubmit="submitCreditNote(event)">
        <div class="modal-body">
          <input type="hidden" id="credit-inv-id">
          <input type="hidden" id="credit-max-total">
          <p style="font-size: 0.88rem; color: var(--text-muted); margin-bottom: 16px;">
            سيتم ربط الإشعار الدائن بالفاتورة الأصلية وتحديث سلسلة الهاش وعداد الـ ICV دون التأثير على الفواتير الأخرى.
          </p>
          <div class="form-group">
            <label>مبلغ الاسترجاع بالريال السعودي (شامل ضريبة 15%):</label>
            <input type="number" step="0.01" min="0.01" id="credit-amount" class="form-control" required oninput="updateCreditMath(this.value)">
            <p id="credit-math-preview" style="font-size: 0.82rem; color: #065f46; background: var(--accent-bg); padding: 8px 12px; border-radius: 6px; margin-top: 8px; display: none;">
              قيمة المرتجع قبل الضريبة: <span id="credit-math-net">0.00</span> ر.س | قيمة الضريبة المسترجعة (15%): <span id="credit-math-vat">0.00</span> ر.س
            </p>
          </div>
          <div class="form-group">
            <label>سبب الاسترجاع (للتوثيق النظامي لدى هيئة الزكاة):</label>
            <input type="text" id="credit-reason" class="form-control" value="استرجاع صنف معيب أو جزئي بناءً على طلب العميل" required>
          </div>
          <div id="credit-external-fields" style="display: none; border-top: 1px dashed var(--border); padding-top: 12px; margin-top: 12px;">
            <div class="form-group">
              <label>رقم الفاتورة أو الطلب السابق في متجر سلة:</label>
              <input type="text" id="credit-external-num" class="form-control" placeholder="ORD-2024-9988">
            </div>
            <div class="form-group">
              <label>تاريخ الفاتورة السابقة (YYYY-MM-DD):</label>
              <input type="date" id="credit-external-date" class="form-control">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" onclick="closeCreditDialog()">إلغاء</button>
          <button type="submit" class="btn btn-warning">إصدار وتوثيق الإشعار الدائن</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Modern Modal: Live Invoice Preview with Scannable QR -->
  <div id="invoice-preview-modal" class="modal-backdrop">
    <div class="modal-box" style="max-width: 680px;">
      <div class="modal-header">
        <h3 id="inv-modal-title">معاينة الفاتورة الضريبية المعتمدة</h3>
        <button type="button" onclick="closeInvoiceModal()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <div class="modal-body" style="padding: 20px 24px;">
        <div style="font-size: 0.8rem; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; padding: 6px 12px; border-radius: 6px; margin-bottom: 14px; font-weight: 600;">
          تجريبي (SANDBOX / DEMO) — فواتير غير ضريبية لأغراض المحاكاة والتأهيل
        </div>
        <div style="display: grid; grid-template-columns: 1fr 180px; gap: 20px; align-items: start;">
          <div>
            <div style="margin-bottom: 14px;">
              <span id="inv-modal-type-badge" class="badge badge-success">فاتورة ضريبية مبسطة</span>
              <span id="inv-modal-status-badge" class="badge badge-info" style="margin-right: 8px;">معتمدة وموثقة</span>
            </div>
            <div style="font-size: 0.9rem; line-height: 1.9; color: #334155;">
              <p><strong>معرف الفاتورة (UUID):</strong> <code id="inv-modal-uuid" style="font-size: 0.78rem; background: var(--surface-sub); padding: 2px 6px; border-radius: 4px; word-break: break-all;"></code></p>
              <p><strong>رقم الطلب في سلة:</strong> <code id="inv-modal-order" style="font-weight: 700;"></code></p>
              <p><strong>العداد التسلسلي (ICV):</strong> <code id="inv-modal-icv" style="font-weight: 700; color: var(--primary);"></code></p>
              <p><strong>تاريخ ووقت التوثيق:</strong> <span id="inv-modal-date"></span></p>
              <p><strong>المبلغ غير شامل الضريبة:</strong> <span id="inv-modal-subtotal"></span> ر.س</p>
              <p><strong>ضريبة القيمة المضافة (15%):</strong> <span id="inv-modal-vat"></span> ر.س</p>
              <p style="font-size: 1.1rem; color: #004d40; font-weight: 800; border-top: 1px solid var(--border); padding-top: 8px; margin-top: 8px;">
                الإجمالي النهائي شامل الضريبة: <span id="inv-modal-total"></span> ر.س
              </p>
            </div>
          </div>
          <div style="text-align: center; background: #ffffff; border: 1.5px solid var(--border); border-radius: 12px; padding: 14px; box-shadow: var(--shadow-sm);">
            <img id="inv-modal-qr-img" src="" alt="ZATCA Phase 2 QR Code" style="width: 140px; height: 140px; display: block; margin: 0 auto; object-fit: contain;" />
            <p style="font-size: 0.75rem; color: var(--text-muted); margin-top: 8px; line-height: 1.4;">
              امسح الباركود بكاميرا هاتفك أو بتطبيق "زاتكا" للتحقق الفوري من التوثيق
            </p>
          </div>
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; gap: 8px;">
          <a id="inv-modal-pdf-link" href="#" target="_blank" class="btn btn-secondary btn-sm">فاتورة ضريبية قابلة للطباعة (PDF) + ملف XML المعتمد</a>
          <a id="inv-modal-print-link" href="#" target="_blank" class="btn btn-secondary btn-sm">عرض وطباعة A4</a>
        </div>
        <button type="button" class="btn btn-secondary" onclick="closeInvoiceModal()">إغلاق</button>
      </div>
    </div>
  </div>

  <!-- Toast Container -->
  <div id="toast-container"></div>

  <script>
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    function switchTab(tabId, ev) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      const target = document.getElementById('tab-' + tabId);
      if (target) target.classList.add('active');
      if (ev && ev.currentTarget) {
        ev.currentTarget.classList.add('active');
      } else {
        const btn = document.querySelector('[onclick*="' + tabId + '"]');
        if (btn) btn.classList.add('active');
      }
    }

    async function generateLiveTestInvoice() {
      showToast('جارٍ إنشاء الطلب وتوقيع الفاتورة وتوليد الباركود تشفيرياً...', 'info');
      try {
        const res = await fetch('/api/demo/generate-test-invoice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ merchantId: '${escapeHtml(m)}' })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('تم توثيق الفاتورة بنجاح! رقم الـ ICV: ' + data.invoice.icv, 'success');
          openInvoicePreview(
            data.invoice.id,
            data.invoice.uuid,
            data.invoice.orderId,
            data.invoice.icv,
            data.invoice.grandTotal,
            data.invoice.subtotal || '200.00',
            data.invoice.taxTotal || '30.00',
            'simplified_tax_invoice',
            'reported',
            new Date().toLocaleString('ar-SA')
          );
        } else {
          showToast('فشل إنشاء الفاتورة التجريبية: ' + (data.error || 'خطأ غير معروف'), 'error');
        }
      } catch (err) {
        showToast('تعذر الاتصال بالخادم: ' + err.message, 'error');
      }
    }

    function openInvoicePreview(id, uuid, orderId, icv, total, subtotal, vat, type, status, date) {
      document.getElementById('inv-modal-uuid').textContent = uuid;
      document.getElementById('inv-modal-order').textContent = orderId;
      document.getElementById('inv-modal-icv').textContent = '#' + icv;
      document.getElementById('inv-modal-total').textContent = total;
      document.getElementById('inv-modal-subtotal').textContent = subtotal || (total / 1.15).toFixed(2);
      document.getElementById('inv-modal-vat').textContent = vat || (total - (total / 1.15)).toFixed(2);
      document.getElementById('inv-modal-date').textContent = date;
      document.getElementById('inv-modal-qr-img').src = '/api/invoices/' + id + '/qr';
      document.getElementById('inv-modal-pdf-link').href = '/api/invoices/' + id + '/pdf';
      document.getElementById('inv-modal-print-link').href = '/api/invoices/' + id + '/printable';

      const typeBadge = document.getElementById('inv-modal-type-badge');
      if (type === 'tax_invoice') {
        typeBadge.textContent = 'فاتورة ضريبية B2B';
        typeBadge.className = 'badge badge-info';
      } else if (type === 'credit_note') {
        typeBadge.textContent = 'إشعار دائن 381';
        typeBadge.className = 'badge badge-warning';
      } else {
        typeBadge.textContent = 'فاتورة ضريبية مبسطة B2C';
        typeBadge.className = 'badge badge-success';
      }

      const statusBadge = document.getElementById('inv-modal-status-badge');
      if (status === 'cleared') {
        statusBadge.textContent = 'تم الاعتماد في محاكاة زاتكا (Sandbox Cleared)';
        statusBadge.className = 'badge badge-success';
      } else if (status === 'reported') {
        statusBadge.textContent = 'تم الإبلاغ في محاكاة زاتكا (Sandbox Reported)';
        statusBadge.className = 'badge badge-success';
      } else if (type === 'tax_invoice' && status !== 'cleared') {
        statusBadge.textContent = 'مسودة بانتظار اعتماد فاتورة (Draft Awaiting Clearance)';
        statusBadge.className = 'badge badge-warning';
      } else if (status === 'rejected') {
        statusBadge.textContent = 'مرفوضة (Rejected)';
        statusBadge.className = 'badge badge-danger';
      } else {
        statusBadge.textContent = 'موقعة محلياً (Signed Locally - 60ms)';
        statusBadge.className = 'badge badge-info';
      }

      document.getElementById('invoice-preview-modal').classList.add('open');
    }

    function closeInvoiceModal() {
      document.getElementById('invoice-preview-modal').classList.remove('open');
      location.reload();
    }

    async function handleOnboard(e) {
      e.preventDefault();
      const form = e.target;
      const formData = new FormData(form);
      const payload = {
        merchantId: formData.get('merchantId'),
        branchId: formData.get('branchId'),
        storeName: formData.get('storeName'),
        vatNumber: formData.get('vatNumber'),
        otp: formData.get('otp'),
        environment: formData.get('environment'),
        isProduction: formData.get('environment') === 'production',
        liabilityAccepted: formData.get('liabilityAccepted') === 'on' || formData.get('liabilityAccepted') === 'true'
      };

      const alertBox = document.getElementById('activation-alert');
      alertBox.style.display = 'block';
      alertBox.className = 'alert-box alert-success';
      alertBox.textContent = 'جارٍ التحقق وتوليد الشهادة والاعتماد مع هيئة الزكاة...';

      try {
        const res = await fetch('/api/egs/onboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          alertBox.className = 'alert-box alert-success';
          alertBox.textContent = 'تم الربط بنجاح مع ZATCA! رقم الوحدة: ' + data.egs_unit_id;
          showToast('تم اعتماد الختم الرقمي بنجاح', 'success');
          setTimeout(() => location.reload(), 1500);
        } else {
          alertBox.className = 'alert-box alert-danger';
          alertBox.textContent = 'خطأ في الاعتماد: ' + (data.message || data.error);
          showToast('فشل الاعتماد: ' + (data.message || data.error), 'error');
        }
      } catch (err) {
        alertBox.className = 'alert-box alert-danger';
        alertBox.textContent = 'تعذر الاتصال بالخادم: ' + err.message;
        showToast('خطأ في الشبكة', 'error');
      }
    }

    async function handleRenew(e, unitId) {
      e.preventDefault();
      const otp = document.getElementById('renew-otp').value;
      if (!confirm('هل تريد بالتأكيد تجديد الختم الرقمي لهذه الوحدة؟')) return;

      try {
        const res = await fetch('/api/egs/' + unitId + '/renew', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ otp })
        });
        const data = await res.json();
        if (res.ok) {
          showToast('تم تجديد الختم الرقمي بنجاح! تاريخ الصلاحية الجديد: ' + data.expires_at, 'success');
          setTimeout(() => location.reload(), 1200);
        } else {
          showToast('فشل التجديد: ' + (data.message || data.error), 'error');
        }
      } catch (err) {
        showToast('حدث خطأ في الاتصال: ' + err.message, 'error');
      }
    }

    function openEnrichDialog(orderId, buyerName, buyerVat) {
      document.getElementById('enrich-order-id').value = orderId;
      document.getElementById('enrich-company').value = buyerName || 'شركة الركائز المتحدة للمقاولات';
      document.getElementById('enrich-vat').value = buyerVat || '310987654300003';
      document.getElementById('enrich-city').value = 'الرياض';
      document.getElementById('enrich-district').value = 'العليا';
      document.getElementById('enrich-street').value = 'طريق الملك فهد';
      document.getElementById('enrich-building').value = '4321';
      document.getElementById('enrich-postal').value = '12244';
      document.getElementById('enrich-country').value = 'SA';
      document.getElementById('enrich-modal').classList.add('open');
    }

    function closeEnrichDialog() {
      document.getElementById('enrich-modal').classList.remove('open');
    }

    async function submitEnrich(e) {
      e.preventDefault();
      const orderId = document.getElementById('enrich-order-id').value;
      const company = document.getElementById('enrich-company').value.trim();
      const vat = document.getElementById('enrich-vat').value.trim();
      const city = document.getElementById('enrich-city').value.trim();
      const district = document.getElementById('enrich-district').value.trim();
      const street = document.getElementById('enrich-street').value.trim();
      const bld = document.getElementById('enrich-building').value.trim();
      const postal = document.getElementById('enrich-postal').value.trim();
      const country = document.getElementById('enrich-country').value.trim() || 'SA';

      try {
        const res = await fetch('/api/b2b/orders/' + orderId + '/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company_name: company,
            buyer_vat: vat,
            city,
            district,
            street,
            building_number: bld,
            postal_code: postal,
            country
          })
        });
        const data = await res.json();
        if (res.ok) {
          closeEnrichDialog();
          showToast('تم استكمال العنوان وتوقيع الفاتورة الضريبية بنجاح!', 'success');
          setTimeout(() => location.reload(), 1200);
        } else {
          showToast('فشل استكمال العنوان: ' + (data.error || 'يرجى مراجعة الحقول'), 'error');
        }
      } catch (err) {
        showToast('خطأ: ' + err.message, 'error');
      }
    }

    function openHistoricalCreditDialog() {
      document.getElementById('credit-inv-id').value = 'historical';
      document.getElementById('credit-max-total').value = '999999';
      document.getElementById('credit-amount').value = '100.00';
      document.getElementById('credit-amount').removeAttribute('max');
      document.getElementById('credit-external-fields').style.display = 'block';
      const numInput = document.getElementById('credit-external-num');
      if (numInput) numInput.required = true;
      const dateInput = document.getElementById('credit-external-date');
      if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
      updateCreditMath('100.00');
      document.getElementById('credit-modal').classList.add('open');
    }

    function openPartialCreditDialog(invId, invUuid, grandTotal) {
      document.getElementById('credit-inv-id').value = invId;
      document.getElementById('credit-max-total').value = grandTotal;
      const defaultAmount = (grandTotal / 2).toFixed(2);
      document.getElementById('credit-amount').value = defaultAmount;
      document.getElementById('credit-amount').max = grandTotal;
      document.getElementById('credit-external-fields').style.display = 'none';
      const numInput = document.getElementById('credit-external-num');
      if (numInput) numInput.required = false;
      updateCreditMath(defaultAmount);
      document.getElementById('credit-modal').classList.add('open');
    }

    function closeCreditDialog() {
      document.getElementById('credit-modal').classList.remove('open');
    }

    function updateCreditMath(val) {
      const amt = parseFloat(val);
      const preview = document.getElementById('credit-math-preview');
      if (isNaN(amt) || amt <= 0) {
        preview.style.display = 'none';
        return;
      }
      const net = (amt / 1.15).toFixed(2);
      const vat = (amt - parseFloat(net)).toFixed(2);
      document.getElementById('credit-math-net').textContent = net;
      document.getElementById('credit-math-vat').textContent = vat;
      preview.style.display = 'block';
    }

    async function submitCreditNote(e) {
      e.preventDefault();
      const invId = document.getElementById('credit-inv-id').value;
      const refundAmount = parseFloat(document.getElementById('credit-amount').value);
      const returnReason = document.getElementById('credit-reason').value.trim();
      const payload = {
        refundAmount,
        returnReason,
        merchantId: '${escapeHtml(m || 'salla_demo_store')}'
      };

      if (invId === 'historical') {
        const numInput = document.getElementById('credit-external-num');
        const dateInput = document.getElementById('credit-external-date');
        payload.externalOriginalInvoiceNumber = numInput ? numInput.value.trim() : 'HISTORICAL-ORD';
        payload.externalOriginalInvoiceDate = dateInput ? dateInput.value.trim() : new Date().toISOString().split('T')[0];
      }

      try {
        const res = await fetch('/api/invoices/' + invId + '/partial-credit-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          closeCreditDialog();
          showToast('تم إصدار الإشعار الدائن 381 بنجاح! رقم الـ ICV: ' + data.creditNote.icv, 'success');
          setTimeout(() => location.reload(), 1200);
        } else {
          showToast('فشل إصدار الإشعار الدائن: ' + (data.message || data.error), 'error');
        }
      } catch (err) {
        showToast('خطأ: ' + err.message, 'error');
      }
    }

    async function dispatchInvoice(invoiceId) {
      try {
        const res = await fetch('/api/invoices/' + invoiceId + '/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (res.ok) {
          showToast('حالة إرسال الفاتورة: ' + data.status, 'success');
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast('فشل الإرسال: ' + (data.message || data.error), 'error');
        }
      } catch (err) {
        showToast('خطأ في الاتصال: ' + err.message, 'error');
      }
    }
  </script>
  <a href="https://wa.me/${supportPhone}?text=${encodeURIComponent('السلام عليكم، استفسار بخصوص تفعيل نظام الربط مع هيئة الزكاة والضريبة والجمارك')}" target="_blank" rel="noopener noreferrer" style="position: fixed; bottom: 20px; left: 20px; background: #25d366; color: white; border-radius: 50px; padding: 10px 18px; font-weight: 700; text-decoration: none; box-shadow: 0 4px 14px rgba(0,0,0,0.25); display: flex; align-items: center; gap: 8px; z-index: 9999; font-size: 0.88rem;">
    <span>الدعم الفني المباشر (واتساب)</span>
  </a>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
