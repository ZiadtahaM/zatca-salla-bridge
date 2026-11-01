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
    let syncRecords: any[] = [];
    let syncStats = {
      total: 0,
      successful: 0,
      review: 0,
      recoverable: 0,
      failed: 0,
      ineligible: 0
    };
    let latestReconciliation: any = null;

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

        const syncRes = await client.query(
          `SELECT id, order_id, sync_state, source_event, invoice_id, invoice_uuid,
                  invoice_type, attempt_count, correlation_id, error_code, error_category,
                  reason, is_recoverable, order_amount, order_currency, customer_summary,
                  last_event_at, next_action, created_at, updated_at
           FROM order_sync_records
           WHERE merchant_id = $1
           ORDER BY updated_at DESC
           LIMIT 100`,
          [merchantId]
        );
        syncRecords = syncRes.rows;

        const statsRes = await client.query(
          `SELECT 
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE sync_state IN ('successfully_cleared', 'successfully_reported', 'successfully_processed'))::int AS successful,
             COUNT(*) FILTER (WHERE sync_state IN ('requires_human_review', 'awaiting_processing'))::int AS review,
             COUNT(*) FILTER (WHERE is_recoverable = TRUE)::int AS recoverable,
             COUNT(*) FILTER (WHERE sync_state IN ('temporarily_failed', 'permanently_failed'))::int AS failed,
             COUNT(*) FILTER (WHERE sync_state = 'not_eligible')::int AS ineligible
           FROM order_sync_records
           WHERE merchant_id = $1`,
          [merchantId]
        );
        if (statsRes.rows.length > 0) {
          syncStats = statsRes.rows[0];
        }

        const reconRes = await client.query(
          `SELECT id, status, started_at, completed_at, total_orders_scanned, discrepancies_found, orders_recovered, error_message
           FROM salla_reconciliation_jobs
           WHERE merchant_id = $1
           ORDER BY started_at DESC
           LIMIT 1`,
          [merchantId]
        );
        if (reconRes.rows.length > 0) {
          latestReconciliation = reconRes.rows[0];
        }
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
      syncRecords,
      syncStats,
      latestReconciliation,
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

  const checkSync = await client.query(
    `SELECT id FROM order_sync_records WHERE merchant_id = 'salla_demo_store' LIMIT 1`
  );
  if (checkSync.rows.length === 0) {
    const rec1Id = randomUUID();
    const rec2Id = randomUUID();
    const rec3Id = randomUUID();
    const rec4Id = randomUUID();
    const rec5Id = randomUUID();

    await client.query(
      `INSERT INTO order_sync_records (
        id, merchant_id, order_id, sync_state, source_event, invoice_uuid, invoice_type,
        attempt_count, correlation_id, is_recoverable, order_amount, order_currency,
        customer_summary, last_event_at, next_action
      ) VALUES
      ($1, 'salla_demo_store', 'ORD-77102', 'successfully_reported', 'order.created', $2, 'simplified_tax_invoice', 1, 'corr-demo-01', FALSE, 345.00, 'SAR', '{"city":"الرياض","country":"SA"}'::jsonb, NOW() - INTERVAL '3 hours', 'تم الإبلاغ بنجاح إلى منصة فاتورة'),
      ($3, 'salla_demo_store', 'ORD-88219', 'successfully_cleared', 'order.created', $4, 'tax_invoice', 1, 'corr-demo-02', FALSE, 4600.00, 'SAR', '{"city":"الرياض","country":"SA"}'::jsonb, NOW() - INTERVAL '2 hours', 'تم اعتماد الفاتورة وتوقيعها من هيئة الزكاة'),
      ($5, 'salla_demo_store', 'ORD-98214', 'requires_human_review', 'order.created', NULL, 'tax_invoice', 1, 'corr-demo-03', FALSE, 12500.00, 'SAR', '{"city":"الرياض","country":"SA"}'::jsonb, NOW() - INTERVAL '4 hours', 'استكمال العنوان الوطني للمشتري في طابور B2B'),
      ($6, 'salla_demo_store', 'ORD-66230', 'temporarily_failed', 'order.status.updated', NULL, 'simplified_tax_invoice', 2, 'corr-demo-04', TRUE, 230.00, 'SAR', '{"city":"جدة","country":"SA"}'::jsonb, NOW() - INTERVAL '30 minutes', 'انقطاع مؤقت في الاتصال مع بوابة الزكاة - إعادة المحاولة متاحة فوراً'),
      ($7, 'salla_demo_store', 'ORD-55110', 'not_eligible', 'order.created', NULL, NULL, 1, 'corr-demo-05', FALSE, 0.00, 'SAR', '{"city":"الدمام","country":"SA"}'::jsonb, NOW() - INTERVAL '5 hours', 'طلب تجريبي ترويجي بقيمة صفرية غير خاضع للضريبة')
      ON CONFLICT (merchant_id, order_id) DO NOTHING`,
      [rec1Id, demoInv1Uuid, rec2Id, demoInv2Uuid, rec3Id, rec4Id, rec5Id]
    );

    await client.query(
      `INSERT INTO order_sync_transitions (
        sync_record_id, merchant_id, order_id, from_state, to_state, source_event, correlation_id, reason, created_at
      ) VALUES
      ($1, 'salla_demo_store', 'ORD-77102', 'not_received', 'received', 'order.created', 'corr-demo-01', 'تم استلام حدث الطلب من ويبهوك سلة', NOW() - INTERVAL '3 hours 5 minutes'),
      ($1, 'salla_demo_store', 'ORD-77102', 'received', 'persisted', 'order.created', 'corr-demo-01', 'تم تخزين بيانات الطلب والتحقق من عدم التكرار', NOW() - INTERVAL '3 hours 4 minutes'),
      ($1, 'salla_demo_store', 'ORD-77102', 'persisted', 'processing', 'order.created', 'corr-demo-01', 'جارٍ إعداد وثيقة UBL وتوليد الهاش وتوقيع الفاتورة', NOW() - INTERVAL '3 hours 3 minutes'),
      ($1, 'salla_demo_store', 'ORD-77102', 'processing', 'successfully_processed', 'order.created', 'corr-demo-01', 'تم توقيع الفاتورة محلياً بنجاح وتوليد الباركود', NOW() - INTERVAL '3 hours 2 minutes'),
      ($1, 'salla_demo_store', 'ORD-77102', 'successfully_processed', 'successfully_reported', 'order.created', 'corr-demo-01', 'تم الإبلاغ لمنصة فاتورة (ZATCA Reporting) بنجاح', NOW() - INTERVAL '3 hours'),

      ($2, 'salla_demo_store', 'ORD-66230', 'not_received', 'received', 'order.status.updated', 'corr-demo-04', 'تم استلام تحديث حالة الطلب من سلة', NOW() - INTERVAL '35 minutes'),
      ($2, 'salla_demo_store', 'ORD-66230', 'received', 'persisted', 'order.status.updated', 'corr-demo-04', 'تم التحقق من اكتمال الدفع', NOW() - INTERVAL '34 minutes'),
      ($2, 'salla_demo_store', 'ORD-66230', 'persisted', 'processing', 'order.status.updated', 'corr-demo-04', 'بدء تجهيز الفاتورة والإرسال للبوابة', NOW() - INTERVAL '32 minutes'),
      ($2, 'salla_demo_store', 'ORD-66230', 'processing', 'temporarily_failed', 'order.status.updated', 'corr-demo-04', 'انقطاع مؤقت في الشبكة أثناء الاتصال ببوابة زاتكا', NOW() - INTERVAL '30 minutes')`,
      [rec1Id, rec4Id]
    );

    await client.query(
      `INSERT INTO salla_reconciliation_jobs (
        merchant_id, status, started_at, completed_at, total_orders_scanned, discrepancies_found, orders_recovered
      ) VALUES (
        'salla_demo_store', 'completed', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours 58 minutes', 48, 1, 1
      )`
    );
  }
}

function renderPortalHtml(data: {
  merchantId: string;
  storeTokens: any;
  subscription: any;
  egsUnits: any[];
  pendingB2b: any[];
  invoices: any[];
  dlqItems: any[];
  syncRecords?: any[];
  syncStats?: any;
  latestReconciliation?: any;
  activeTab: string;
}): string {
  const m = data.merchantId;
  const store = data.storeTokens || {};
  const sub = data.subscription || { plan_name: 'standard', status: 'active' };
  const primaryUnit = data.egsUnits[0];
  const syncRecords = data.syncRecords || [];
  const syncStats = data.syncStats || { total: 0, successful: 0, review: 0, recoverable: 0, failed: 0, ineligible: 0 };
  const latestReconciliation = data.latestReconciliation || null;

  const stateLabels: Record<string, { ar: string; en: string; badge: string }> = {
    not_received: { ar: 'لم يُستلم بعد', en: 'Not Received', badge: 'badge-secondary' },
    received: { ar: 'تم الاستلام من سلة', en: 'Received', badge: 'badge-info' },
    persisted: { ar: 'تم التخزين في الطابور', en: 'Persisted', badge: 'badge-info' },
    awaiting_processing: { ar: 'بانتظار المعالجة / تأكيد التسليم', en: 'Awaiting Processing', badge: 'badge-warning' },
    processing: { ar: 'جارٍ المعالجة والتشفير', en: 'Processing', badge: 'badge-info' },
    successfully_processed: { ar: 'تم توقيع الفاتورة محلياً', en: 'Signed Locally', badge: 'badge-success' },
    zatca_submission_pending: { ar: 'بانتظار الإرسال لهيئة الزكاة', en: 'ZATCA Pending', badge: 'badge-warning' },
    successfully_reported: { ar: 'تم الإبلاغ بنجاح', en: 'Reported', badge: 'badge-success' },
    successfully_cleared: { ar: 'تم الاعتماد بنجاح', en: 'Cleared', badge: 'badge-success' },
    temporarily_failed: { ar: 'فشل مؤقت (قابل للاستعادة)', en: 'Temporarily Failed', badge: 'badge-warning' },
    permanently_failed: { ar: 'فشل دائم (غير قابل للاستعادة)', en: 'Permanently Failed', badge: 'badge-danger' },
    not_eligible: { ar: 'غير خاضع للضريبة', en: 'Not Eligible', badge: 'badge-secondary' },
    requires_human_review: { ar: 'يتطلب مراجعة بشرية (B2B)', en: 'Requires Review', badge: 'badge-warning' }
  };

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
    /* Sync Control & Recovery Styles */
    .sync-filter-bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 20px; background: var(--surface-sub); padding: 14px 18px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
    .sync-timeline { position: relative; padding: 12px 18px 12px 0; border-right: 2px solid var(--border); margin-right: 12px; }
    .sync-timeline-item { position: relative; margin-bottom: 20px; }
    .sync-timeline-dot { position: absolute; right: -25px; top: 4px; width: 12px; height: 12px; border-radius: 50%; background: #94a3b8; border: 2px solid var(--surface); }
    .sync-timeline-dot.success { background: var(--primary-light); }
    .sync-timeline-dot.warning { background: var(--warning); }
    .sync-timeline-dot.danger { background: var(--danger); }
    .sync-timeline-dot.info { background: var(--info); }
    .code-box { background: #0f172a; color: #f8fafc; padding: 14px 16px; border-radius: var(--radius-sm); font-family: monospace; font-size: 0.8rem; overflow-x: auto; max-height: 380px; direction: ltr; text-align: left; }
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
      <button class="tab-btn ${data.activeTab === 'sync' ? 'active' : ''}" onclick="switchTab('sync', event)">
        5. مزامنة سلة والتعافي (Salla Sync) ${syncStats.recoverable > 0 ? `<span class="badge badge-warning" style="padding:2px 6px; font-size:0.75rem; margin-right:4px;">${syncStats.recoverable}</span>` : ''}
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

    <!-- Tab 5: Salla Sync & Safe Recovery -->
    <div id="tab-sync" class="tab-content ${data.activeTab === 'sync' ? 'active' : ''}">
      <!-- KPI stats grid for Sync -->
      <div class="stats-grid" style="margin-bottom: 20px;">
        <div class="stat-card">
          <div class="stat-info">
            <p>إجمالي الطلبات المرصودة (Tracked Orders)</p>
            <h3>${syncStats.total} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">طلب</span></h3>
          </div>
          <div class="stat-icon blue">📦</div>
        </div>
        <div class="stat-card">
          <div class="stat-info">
            <p>مكتملة وموثقة (Cleared / Reported)</p>
            <h3>${syncStats.successful} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">فاتورة</span></h3>
          </div>
          <div class="stat-icon green">✓</div>
        </div>
        <div class="stat-card">
          <div class="stat-info">
            <p>بانتظار المراجعة (Review / B2B Missing)</p>
            <h3>${syncStats.review} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">طلب</span></h3>
          </div>
          <div class="stat-icon amber">⏳</div>
        </div>
        <div class="stat-card">
          <div class="stat-info">
            <p>فشل مؤقت قابل للاستعادة (Recoverable)</p>
            <h3>${syncStats.recoverable} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">طلب</span></h3>
          </div>
          <div class="stat-icon amber" style="background: #fef3c7; color: #b45309;">🔄</div>
        </div>
        <div class="stat-card">
          <div class="stat-info">
            <p>مستبعدة نظامياً (Not Eligible)</p>
            <h3>${syncStats.ineligible} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">طلب</span></h3>
          </div>
          <div class="stat-icon" style="background: #f1f5f9; color: #64748b;">ℹ</div>
        </div>
      </div>

      <!-- Sync Rules & Cutoff Date Notice -->
      <div class="card" style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 12px;">
          <div>
            <h2 style="font-size: 1.15rem; color: #004d40; font-weight: 700;">
              قواعد المزامنة الذكية مع سلة وشروط الأهلية الضريبية (ZATCA Sync Rules)
            </h2>
            <p style="font-size: 0.85rem; color: #64748b; margin-top: 2px;">
              توضيح شفاف ومباشر لكيفية معالجة الطلبات، شروط الفوترة، وحماية التسلسل الزكوي
            </p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="toggleSyncRulesDetails()">
            <span id="rules-toggle-text">عرض تفاصيل القواعد ▾</span>
          </button>
        </div>

        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; font-size: 0.85rem; line-height: 1.6; color: #166534;">
          <strong>تاريخ بداية المزامنة المعتمد (Activation Cutoff Boundary):</strong>
          تتم معالجة الطلبات المنشأة بعد تاريخ تفعيل شهادة الختم الرقمي للمتجر فقط. الطلبات السابقة لتاريخ التفعيل لا يتم إصدار فواتير لها بصورة تلقائية لحماية تسلسل أرقام الفواتير (ICV) وسلسلة الهاش التشفيرية من الكسر، وتفادي الازدواج الضريبي.
        </div>

        <div id="sync-rules-expanded" style="display: none; border-top: 1px solid var(--border); padding-top: 16px; font-size: 0.88rem; line-height: 1.7; color: #334155;">
          <div class="grid-2" style="gap: 16px;">
            <div style="background: var(--surface-sub); padding: 14px; border-radius: 8px;">
              <h4 style="color: #004d40; font-weight: 700; margin-bottom: 6px;">الأحداث المدعومة (Trigger Events)</h4>
              <p>يتم الاستماع لـ <code>order.created</code>، <code>order.updated</code>، <code>order.status.updated</code>، و <code>order.refunded</code>. الطلبات المدفوعة مسبقاً (بطاقة مدى، فيزا، ماستركارد، أبل باي، تابي، تمارا) تصدر فوراً. طلبات الدفع عند الاستلام (COD) يتم حجزها بحالة <code>awaiting_processing</code> حتى تحديث حالة الشحنة إلى "تم التوصيل" أو "مكتمل".</p>
            </div>
            <div style="background: var(--surface-sub); padding: 14px; border-radius: 8px;">
              <h4 style="color: #004d40; font-weight: 700; margin-bottom: 6px;">حالات الاستبعاد النظامي (Not Eligible)</h4>
              <p>الطلبات المسودة (Draft)، الطلبات الملغاة قبل السداد أو التوريد، والطلبات الترويجية المجانية بقيمة صفرية تُصنف <code>not_eligible</code> ولا تستهلك رقماً تسلسلياً (ICV) ولا ترسل لهيئة الزكاة.</p>
            </div>
            <div style="background: var(--surface-sub); padding: 14px; border-radius: 8px;">
              <h4 style="color: #004d40; font-weight: 700; margin-bottom: 6px;">الإلغاء التشغيلي مقابل الإشعار الدائن 381</h4>
              <p>إلغاء الطلب قبل إصدار الفاتورة وتوريد البضاعة يلغي العملية بدون أثر ضريبي. أما إذا كانت الفاتورة قد صدرت بالفعل ورُفعت لهيئة الزكاة، فإن الإلغاء أو الاسترجاع يتطلب نظاماً إصدار إشعار دائن (نوع 381) برقم ICV جديد مع الإشارة لـ UUID الفاتورة الأصلية والهاش التشفيري السابق.</p>
            </div>
            <div style="background: var(--surface-sub); padding: 14px; border-radius: 8px;">
              <h4 style="color: #004d40; font-weight: 700; margin-bottom: 6px;">ضمانات الاستعادة الآمنة وعدم التكرار</h4>
              <p>عمليات إعادة المحاولة تخضع لقفل تنافسي (PostgreSQL Advisory Lock) لكل متجر. إذا كانت الفاتورة مسجلة مسبقاً في قاعدة البيانات، تستأنف المنظومة الإرسال للبوابة دون إعادة توليد الفاتورة أو حرق رقم ICV جديد نهائياً.</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Reconciliation Action Toolbar -->
      <div class="card" style="margin-bottom: 20px; padding: 16px 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 14px;">
          <div>
            <span style="font-weight: 700; color: #0f172a; font-size: 0.95rem;">المطابقة الذكية وكشف الفروقات (Smart Store Reconciliation)</span>
            <p style="font-size: 0.82rem; color: #64748b; margin-top: 2px;">
              ${latestReconciliation ? `آخر فحص: ${new Date(latestReconciliation.started_at).toLocaleString('ar-SA')} | تم فحص ${latestReconciliation.total_orders_scanned} طلباً | الفروقات المرصودة: ${latestReconciliation.discrepancies_found}` : 'لم يتم تشغيل مطابقة كاملة بعد لهذا المتجر.'}
            </p>
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn btn-primary btn-sm" onclick="startReconciliationModal()" style="gap: 6px;">
              <span>🔍</span> تشغيل المطابقة الآن
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="exportSyncReport()" style="gap: 6px;">
              <span>📊</span> تقرير التدقيق
            </button>
          </div>
        </div>
      </div>

      <!-- Filters and Search Bar -->
      <div class="sync-filter-bar">
        <div style="flex: 1; min-width: 200px;">
          <input type="text" id="sync-search-input" class="form-control" placeholder="بحث برقم الطلب (ORD-...)، معرف الفاتورة، أو المدينة..." oninput="filterSyncTable()" style="padding: 8px 12px; font-size: 0.88rem;">
        </div>
        <div>
          <select id="sync-state-filter" class="form-control" onchange="filterSyncTable()" style="padding: 8px 12px; font-size: 0.88rem;">
            <option value="">جميع الحالات التشغيلية (All States)</option>
            <option value="successfully_cleared">تم الاعتماد (Cleared)</option>
            <option value="successfully_reported">تم الإبلاغ (Reported)</option>
            <option value="requires_human_review">يتطلب مراجعة بشرية (Review)</option>
            <option value="temporarily_failed">فشل مؤقت قابل للاستعادة</option>
            <option value="permanently_failed">فشل دائم</option>
            <option value="awaiting_processing">بانتظار المعالجة / COD</option>
            <option value="not_eligible">غير خاضع للضريبة (Not Eligible)</option>
          </select>
        </div>
        <div>
          <select id="sync-doc-filter" class="form-control" onchange="filterSyncTable()" style="padding: 8px 12px; font-size: 0.88rem;">
            <option value="">جميع أنواع الوثائق</option>
            <option value="simplified_tax_invoice">فاتورة مبسطة B2C</option>
            <option value="tax_invoice">فاتورة ضريبية B2B</option>
            <option value="credit_note">إشعار دائن 381</option>
          </select>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <input type="checkbox" id="sync-action-required" onchange="filterSyncTable()" style="cursor: pointer;">
          <label for="sync-action-required" style="font-size: 0.85rem; color: #334155; cursor: pointer; user-select: none;">الطلبات التي تتطلب إجراء فقط</label>
        </div>
      </div>

      <!-- Orders Sync Table -->
      <div class="card" style="padding: 0; overflow: hidden;">
        <div style="overflow-x: auto;">
          <table id="sync-orders-table">
            <thead>
              <tr>
                <th>رقم الطلب (Order ID)</th>
                <th>الحالة التشغيلية (Sync State)</th>
                <th>نوع الوثيقة</th>
                <th>القيمة</th>
                <th>تاريخ آخر حدث</th>
                <th>المحاولات</th>
                <th>التشخيص والإجراء القادم</th>
                <th style="text-align: center;">الإجراءات المتاحة</th>
              </tr>
            </thead>
            <tbody>
              ${syncRecords.length > 0 ? syncRecords.map(r => {
                const meta = stateLabels[r.sync_state] || { ar: r.sync_state, en: r.sync_state, badge: 'badge-info' };
                const isRecoverable = Boolean(r.is_recoverable);
                const requiresAction = r.sync_state === 'requires_human_review' || isRecoverable;
                return `
                  <tr class="sync-row" data-order-id="${escapeHtml(r.order_id)}" data-state="${escapeHtml(r.sync_state)}" data-doc="${escapeHtml(r.invoice_type || '')}" data-action-required="${requiresAction}">
                    <td>
                      <code style="font-weight: 700; color: #004d40;">${escapeHtml(r.order_id)}</code>
                      ${r.invoice_uuid ? `<div style="font-size: 0.72rem; color: #64748b; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(r.invoice_uuid)}">${escapeHtml(r.invoice_uuid)}</div>` : ''}
                    </td>
                    <td>
                      <span class="badge ${meta.badge}">
                        ${meta.ar}
                      </span>
                      <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">${meta.en}</div>
                    </td>
                    <td style="font-size: 0.85rem;">
                      ${r.invoice_type === 'simplified_tax_invoice' ? 'فاتورة مبسطة B2C' : r.invoice_type === 'tax_invoice' ? 'فاتورة ضريبية B2B' : r.invoice_type === 'credit_note' ? 'إشعار دائن 381' : '<span style="color:#94a3b8;">غير محدد</span>'}
                    </td>
                    <td style="font-weight: 600;">
                      ${r.order_amount ? `${Number(r.order_amount).toFixed(2)} ${r.order_currency || 'SAR'}` : '0.00 SAR'}
                    </td>
                    <td style="font-size: 0.82rem; color: #475569;">
                      ${new Date(r.last_event_at || r.updated_at).toLocaleString('ar-SA')}
                    </td>
                    <td style="text-align: center;">
                      <code>${r.attempt_count}</code>
                    </td>
                    <td style="font-size: 0.82rem; max-width: 240px;">
                      <div style="color: #1e293b; font-weight: 500;">${escapeHtml(r.next_action || r.reason || 'لا يوجد إجراء مطلوب')}</div>
                      ${r.error_category ? `<div style="font-size: 0.72rem; color: #dc2626;">تصنيف الخطأ: ${escapeHtml(r.error_category)}</div>` : ''}
                    </td>
                    <td style="text-align: center;">
                      <div style="display: inline-flex; gap: 6px; align-items: center; justify-content: center;">
                        <button type="button" class="btn btn-secondary btn-sm" onclick="openSyncTimeline('${escapeHtml(r.order_id)}')" title="عرض السجل الزمني من 10 خطوات">
                          ⏱ السجل الزمني
                        </button>
                        ${isRecoverable ? `
                          <button type="button" class="btn btn-warning btn-sm" onclick="openSyncRecovery('${escapeHtml(r.order_id)}', '${escapeHtml(r.reason || '')}')" title="استعادة آمنة فورية دون تكرار الفواتير">
                            🔄 استعادة
                          </button>
                        ` : ''}
                        <button type="button" class="btn btn-secondary btn-sm" onclick="openSyncDiagnostics('${escapeHtml(r.order_id)}')" title="تصدير ملف تشخيص الدعم الفني">
                          📋 تشخيص
                        </button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('') : `
                <tr>
                  <td colspan="8" class="empty-state">
                    <div style="font-size: 1.8rem; margin-bottom: 8px;">📦</div>
                    <p>لا توجد طلبات مسجلة في منظومة المزامنة حتى الآن. ستظهر الطلبات تلقائياً فور وصول أحداث ويبهوك سلة.</p>
                  </td>
                </tr>
              `}
            </tbody>
          </table>
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

  <!-- Modern Modal: Sync Order Timeline -->
  <div id="sync-timeline-modal" class="modal-backdrop">
    <div class="modal-box" style="max-width: 680px;">
      <div class="modal-header">
        <h3 id="timeline-modal-title">السجل الزمني لمزامنة الطلب (10-Step Timeline)</h3>
        <button type="button" onclick="closeSyncTimeline()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <div class="modal-body" style="padding: 20px 24px; max-height: 520px; overflow-y: auto;">
        <div id="timeline-header-info" style="margin-bottom: 16px; background: var(--surface-sub); padding: 12px 16px; border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <strong id="timeline-order-num" style="color: #004d40; font-size: 1.05rem;">ORD-...</strong>
            <span id="timeline-state-badge" class="badge badge-info">جارٍ التحميل...</span>
          </div>
          <div id="timeline-meta-text" style="font-size: 0.82rem; color: #475569; line-height: 1.5;"></div>
        </div>

        <h4 style="font-size: 0.95rem; color: #0f172a; margin-bottom: 14px; font-weight: 700;">سجل التحولات التشغيلية (Transition Audit Trail):</h4>
        <div class="sync-timeline" id="timeline-events-container">
          <!-- Populated dynamically -->
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closeSyncTimeline()">إغلاق</button>
      </div>
    </div>
  </div>

  <!-- Modern Modal: Safe Order Recovery -->
  <div id="sync-recovery-modal" class="modal-backdrop">
    <div class="modal-box" style="max-width: 560px;">
      <div class="modal-header">
        <h3>استعادة آمنة للطلب (Safe Order Recovery)</h3>
        <button type="button" onclick="closeSyncRecovery()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="recovery-target-order">
        <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 14px; margin-bottom: 16px;">
          <h4 style="color: #065f46; font-size: 0.92rem; font-weight: 700; margin-bottom: 6px;">ضمانات الأمان الزكوي أثناء الاستعادة:</h4>
          <ul style="font-size: 0.82rem; color: #047857; margin-right: 18px; line-height: 1.6;">
            <li>لن يتم إنشاء فاتورة مكررة مطلقاً إذا كانت الفاتورة موجودة بقاعدة البيانات.</li>
            <li>لن يتم حرق أو زيادة عداد الفواتير (ICV) إذا كانت الفاتورة موقعة مسبقاً.</li>
            <li>يتم حجز قفل تنافسي (PostgreSQL Advisory Lock) لمنع التداخل والتعارض.</li>
            <li>الاستئناف التلقائي لعملية الإرسال والاعتماد لدى هيئة الزكاة.</li>
          </ul>
        </div>

        <div style="margin-bottom: 14px;">
          <p style="font-size: 0.88rem; color: #334155;">رقم الطلب المستهدف: <code id="recovery-order-label" style="font-weight: 700; color: #004d40;"></code></p>
          <p style="font-size: 0.85rem; color: #64748b; margin-top: 4px;">سبب الفشل السابق: <span id="recovery-reason-text"></span></p>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closeSyncRecovery()">إلغاء</button>
        <button type="button" id="recovery-confirm-btn" class="btn btn-warning" onclick="triggerSyncRecovery()">
          تأكيد الاستعادة الآمنة الآن
        </button>
      </div>
    </div>
  </div>

  <!-- Modern Modal: Redacted Support Diagnostics -->
  <div id="sync-diagnostics-modal" class="modal-backdrop">
    <div class="modal-box" style="max-width: 720px;">
      <div class="modal-header">
        <h3>ملف تشخيص الدعم الفني (Redacted Diagnostics)</h3>
        <button type="button" onclick="closeSyncDiagnostics()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <div class="modal-body">
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 14px; margin-bottom: 14px; font-size: 0.82rem; color: #15803d;">
          🛡️ <strong>حماية البيانات والسرية التامة:</strong> هذا الملف منقح تشفيرياً 100% ولا يحتوي على أي مفاتيح خاصة، كلمات مرور، رموز وصول (Tokens)، أو بيانات شخصية للعميل (Zero-PII).
        </div>
        <div class="code-box" id="diagnostics-code-view">
          جارٍ إعداد ملف التشخيص...
        </div>
      </div>
      <div class="modal-footer" style="display: flex; justify-content: space-between;">
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="copyDiagnosticsJson()">نسخ التقرير</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="downloadDiagnosticsJson()">تحميل بصيغة JSON</button>
        </div>
        <button type="button" class="btn btn-secondary" onclick="closeSyncDiagnostics()">إغلاق</button>
      </div>
    </div>
  </div>

  <!-- Modern Modal: Reconciliation -->
  <div id="sync-reconcile-modal" class="modal-backdrop">
    <div class="modal-box" style="max-width: 540px;">
      <div class="modal-header">
        <h3>تشغيل المطابقة الذكية مع متجر سلة</h3>
        <button type="button" onclick="closeReconcileModal()" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--text-muted);">&times;</button>
      </div>
      <div class="modal-body">
        <p style="font-size: 0.88rem; color: #334155; margin-bottom: 14px; line-height: 1.6;">
          تقوم المطابقة الذكية بفحص سجل طلبات المتجر عبر واجهة سلة ومقارنتها بسجلات الفوترة الزكوية لكشف أي أحداث مفقودة (Missed Webhooks) أو فروقات في الحالات دون إنشاء فواتير عشوائية.
        </p>
        <div class="form-group">
          <label>النطاق الزمني للمطابقة:</label>
          <select id="reconcile-window" class="form-control">
            <option value="24h">آخر 24 ساعة (الأكثر دقة للطلبات اليومية)</option>
            <option value="7d">آخر 7 أيام (أسبوعي)</option>
            <option value="30d">آخر 30 يوماً (شهري شامل)</option>
          </select>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="closeReconcileModal()">إلغاء</button>
        <button type="button" id="reconcile-start-btn" class="btn btn-primary" onclick="executeReconciliation()">
          بدء فحص ومطابقة الطلبات
        </button>
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

    /* Salla Sync & Safe Recovery JavaScript Functions */
    function toggleSyncRulesDetails() {
      const el = document.getElementById('sync-rules-expanded');
      const text = document.getElementById('rules-toggle-text');
      if (el.style.display === 'none' || !el.style.display) {
        el.style.display = 'block';
        if (text) text.textContent = 'إخفاء تفاصيل القواعد ▴';
      } else {
        el.style.display = 'none';
        if (text) text.textContent = 'عرض تفاصيل القواعد ▾';
      }
    }

    function filterSyncTable() {
      const search = (document.getElementById('sync-search-input').value || '').toLowerCase().trim();
      const state = (document.getElementById('sync-state-filter').value || '').trim();
      const doc = (document.getElementById('sync-doc-filter').value || '').trim();
      const actionReq = document.getElementById('sync-action-required').checked;

      const rows = document.querySelectorAll('.sync-row');
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        const rowState = row.getAttribute('data-state') || '';
        const rowDoc = row.getAttribute('data-doc') || '';
        const rowAction = row.getAttribute('data-action-required') === 'true';

        let matchesSearch = !search || text.includes(search);
        let matchesState = !state || rowState === state;
        let matchesDoc = !doc || rowDoc === doc;
        let matchesAction = !actionReq || rowAction;

        if (matchesSearch && matchesState && matchesDoc && matchesAction) {
          row.style.display = '';
        } else {
          row.style.display = 'none';
        }
      });
    }

    let activeDiagnosticsData = null;

    async function openSyncTimeline(orderId) {
      document.getElementById('timeline-modal-title').textContent = 'السجل الزمني لمزامنة الطلب: ' + orderId;
      document.getElementById('timeline-order-num').textContent = orderId;
      document.getElementById('timeline-state-badge').textContent = 'جارٍ تحميل السجل...';
      document.getElementById('timeline-meta-text').textContent = '';
      const container = document.getElementById('timeline-events-container');
      container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">جارٍ جلب السجل من قاعدة البيانات...</div>';
      document.getElementById('sync-timeline-modal').classList.add('open');

      try {
        const res = await fetch('/api/sync/orders/' + encodeURIComponent(orderId) + '?merchantId=${encodeURIComponent(m)}');
        const data = await res.json();
        if (res.ok && data.order) {
          const ord = data.order;
          document.getElementById('timeline-state-badge').textContent = ord.sync_state;
          document.getElementById('timeline-meta-text').innerHTML = 
            'نوع الوثيقة: <strong>' + (ord.invoice_type || 'غير محدد') + '</strong> | عدد المحاولات: <strong>' + ord.attempt_count + '</strong> | معرف الارتباط: <code>' + (ord.correlation_id || 'N/A') + '</code>';

          if (ord.history && ord.history.length > 0) {
            container.innerHTML = ord.history.map((t, idx) => {
              let dotClass = 'info';
              if (t.to_state.includes('success') || t.to_state === 'cleared' || t.to_state === 'reported') dotClass = 'success';
              else if (t.to_state.includes('failed') || t.to_state === 'rejected') dotClass = 'danger';
              else if (t.to_state.includes('review') || t.to_state.includes('pending') || t.to_state.includes('awaiting')) dotClass = 'warning';

              const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              return (
                '<div class="sync-timeline-item">' +
                  '<div class="sync-timeline-dot ' + dotClass + '"></div>' +
                  '<div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">' +
                    '<strong style="color: #0f172a; font-size: 0.9rem;">' +
                      '#' + (idx + 1) + ' التحول إلى: <span style="color: #004d40;">' + esc(t.to_state) + '</span>' +
                      (t.from_state ? ' <span style="font-size: 0.78rem; color: #64748b; font-weight: normal;">(من ' + esc(t.from_state) + ')</span>' : '') +
                    '</strong>' +
                    '<span style="font-size: 0.75rem; color: #64748b;">' + new Date(t.created_at).toLocaleTimeString('ar-SA') + '</span>' +
                  '</div>' +
                  '<p style="font-size: 0.82rem; color: #334155; line-height: 1.5;">' + esc(t.reason || 'تم تسجيل التحول التشغيلي') + '</p>' +
                  (t.error_category ? '<div style="font-size: 0.75rem; color: #dc2626; margin-top: 2px;">تصنيف الخطأ: ' + esc(t.error_category) + ' (' + esc(t.error_code || '') + ')</div>' : '') +
                  (t.source_event ? '<div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">حدث المصدر: <code>' + esc(t.source_event) + '</code></div>' : '') +
                '</div>'
              );
            }).join('');
          } else {
            container.innerHTML = '<div class="empty-state"><p>لا توجد تحولات مسجلة بعد لهذا الطلب.</p></div>';
          }
        } else {
          container.innerHTML = '<div class="empty-state"><p>تعذر جلب تفاصيل السجل: ' + (data.message || data.error) + '</p></div>';
        }
      } catch (err) {
        container.innerHTML = '<div class="empty-state"><p>خطأ في الاتصال: ' + err.message + '</p></div>';
      }
    }

    function closeSyncTimeline() {
      document.getElementById('sync-timeline-modal').classList.remove('open');
    }

    function openSyncRecovery(orderId, reason) {
      document.getElementById('recovery-target-order').value = orderId;
      document.getElementById('recovery-order-label').textContent = orderId;
      document.getElementById('recovery-reason-text').textContent = reason || 'انقطاع مؤقت أو بانتظار إعادة المحاولة';
      document.getElementById('recovery-confirm-btn').disabled = false;
      document.getElementById('recovery-confirm-btn').textContent = 'تأكيد الاستعادة الآمنة الآن';
      document.getElementById('sync-recovery-modal').classList.add('open');
    }

    function closeSyncRecovery() {
      document.getElementById('sync-recovery-modal').classList.remove('open');
    }

    async function triggerSyncRecovery() {
      const orderId = document.getElementById('recovery-target-order').value;
      const btn = document.getElementById('recovery-confirm-btn');
      btn.disabled = true;
      btn.textContent = 'جارٍ التحقق وتأمين القفل التنافسي...';

      try {
        const res = await fetch('/api/sync/orders/' + encodeURIComponent(orderId) + '/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ merchantId: '${escapeHtml(m)}', reason: 'طلب استعادة آمنة يدوي من لوحة التحكم' })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('تمت معالجة الاستعادة بنجاح! الحالة: ' + data.sync_state, 'success');
          closeSyncRecovery();
          setTimeout(() => location.reload(), 1200);
        } else {
          showToast('تعذرت الاستعادة: ' + (data.message || data.error), 'error');
          btn.disabled = false;
          btn.textContent = 'إعادة المحاولة';
        }
      } catch (err) {
        showToast('خطأ في الاتصال: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'إعادة المحاولة';
      }
    }

    async function openSyncDiagnostics(orderId) {
      const codeView = document.getElementById('diagnostics-code-view');
      codeView.textContent = 'جارٍ استخراج وتدقيق بيانات التشخيص وتجريد الأسرار...';
      document.getElementById('sync-diagnostics-modal').classList.add('open');
      activeDiagnosticsData = null;

      try {
        const res = await fetch('/api/sync/orders/' + encodeURIComponent(orderId) + '/diagnostics?merchantId=${escapeHtml(m)}');
        const data = await res.json();
        if (res.ok) {
          activeDiagnosticsData = data;
          codeView.textContent = JSON.stringify(data, null, 2);
        } else {
          codeView.textContent = 'فشل تحميل التشخيص: ' + (data.message || data.error);
        }
      } catch (err) {
        codeView.textContent = 'خطأ في الاتصال: ' + err.message;
      }
    }

    function closeSyncDiagnostics() {
      document.getElementById('sync-diagnostics-modal').classList.remove('open');
    }

    function copyDiagnosticsJson() {
      if (!activeDiagnosticsData) {
        showToast('لا توجد بيانات تشخيص لنسخها', 'warning');
        return;
      }
      navigator.clipboard.writeText(JSON.stringify(activeDiagnosticsData, null, 2)).then(() => {
        showToast('تم نسخ تقرير التشخيص المنقح بنجاح', 'success');
      }).catch(() => {
        showToast('تعذر النسخ التلقائي للحافظة', 'error');
      });
    }

    function downloadDiagnosticsJson() {
      if (!activeDiagnosticsData) {
        showToast('لا توجد بيانات تشخيص للتحميل', 'warning');
        return;
      }
      const orderId = (activeDiagnosticsData.order && activeDiagnosticsData.order.order_id) || 'unknown';
      const blob = new Blob([JSON.stringify(activeDiagnosticsData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zatca-diagnostics-' + orderId + '.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('تم بدء تحميل ملف التشخيص', 'info');
    }

    function startReconciliationModal() {
      document.getElementById('reconcile-start-btn').disabled = false;
      document.getElementById('reconcile-start-btn').textContent = 'بدء فحص ومطابقة الطلبات';
      document.getElementById('sync-reconcile-modal').classList.add('open');
    }

    function closeReconcileModal() {
      document.getElementById('sync-reconcile-modal').classList.remove('open');
    }

    async function executeReconciliation() {
      const windowVal = document.getElementById('reconcile-window').value;
      const btn = document.getElementById('reconcile-start-btn');
      btn.disabled = true;
      btn.textContent = 'جارٍ فحص متجر سلة وكشف الفروقات...';

      let fromDate = new Date();
      if (windowVal === '24h') fromDate.setHours(fromDate.getHours() - 24);
      else if (windowVal === '7d') fromDate.setDate(fromDate.getDate() - 7);
      else if (windowVal === '30d') fromDate.setDate(fromDate.getDate() - 30);

      try {
        const res = await fetch('/api/sync/reconcile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merchantId: '${escapeHtml(m)}',
            fromDate: fromDate.toISOString(),
            toDate: new Date().toISOString()
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('اكتملت المطابقة! الطلبات المفحوصة: ' + data.orders_scanned + ' | الفروقات: ' + data.discrepancies_found, 'success');
          closeReconcileModal();
          setTimeout(() => location.reload(), 1500);
        } else {
          showToast('فشلت المطابقة: ' + (data.message || data.error), 'error');
          btn.disabled = false;
          btn.textContent = 'إعادة المحاولة';
        }
      } catch (err) {
        showToast('خطأ في الاتصال: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'إعادة المحاولة';
      }
    }

    function exportSyncReport() {
      window.open('/api/sync/orders?merchantId=${encodeURIComponent(m)}', '_blank');
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
