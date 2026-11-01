import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../storage/db.js';
import {
  queryOrderSyncRecords,
  getOrderSyncWithHistory,
  getSyncRulesExplanation,
  generateSyncPreview,
  executeSafeOrderRecovery,
  generateOrderSupportDiagnostics,
  SyncState
} from '../services/sync-service.js';
import {
  runStoreReconciliation,
  getLatestReconciliationSummary
} from '../services/reconciliation-service.js';
import { authenticateMerchantRequest } from '../crypto/auth-session.js';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const syncRateLimitMap = new Map<string, RateLimitBucket>();

function checkRateLimit(key: string, maxRequests: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = syncRateLimitMap.get(key);
  if (!bucket || now >= bucket.resetAt) {
    syncRateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (bucket.count >= maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  bucket.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetSyncRateLimitsForTesting(): void {
  syncRateLimitMap.clear();
}

function extractMerchantId(request: FastifyRequest): string {
  const query = (request.query || {}) as Record<string, any>;
  const body = (request.body || {}) as Record<string, any>;
  const params = (request.params || {}) as Record<string, any>;

  return (
    query.merchantId ||
    query.merchant ||
    query.merchant_id ||
    body.merchantId ||
    body.merchant ||
    body.merchant_id ||
    params.merchantId ||
    'salla_demo_store'
  ).toString().trim();
}

export async function syncControlRoutes(fastify: FastifyInstance): Promise<void> {
  // 1. Query Orders Synchronization Table
  fastify.get('/api/sync/orders', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({ error: 'UNAUTHORIZED', message: auth.error });
    }

    const query = (request.query || {}) as {
      search?: string;
      state?: string;
      syncState?: string;
      fromDate?: string;
      toDate?: string;
      documentType?: 'tax_invoice' | 'simplified_tax_invoice' | 'credit_note';
      onlyRequiresAction?: string;
      limit?: string;
      offset?: string;
    };

    const client = await pool.connect();
    try {
      const stateParam = (query.syncState || query.state || 'all') as SyncState | 'failed' | 'all';
      const result = await queryOrderSyncRecords(client, merchantId, {
        search: query.search,
        syncState: stateParam,
        fromDate: query.fromDate,
        toDate: query.toDate,
        documentType: query.documentType,
        onlyRequiresAction: query.onlyRequiresAction === 'true',
        limit: query.limit ? parseInt(query.limit, 10) : 20,
        offset: query.offset ? parseInt(query.offset, 10) : 0
      });

      return reply.status(200).send({
        merchant_id: merchantId,
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        records: result.records
      });
    } finally {
      client.release();
    }
  });

  // 2. Get Order Chronological Sync History (10-step history)
  fastify.get('/api/sync/orders/:orderId', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({ error: 'UNAUTHORIZED', message: auth.error });
    }

    const { orderId } = request.params as { orderId: string };
    if (!orderId || typeof orderId !== 'string' || orderId.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(orderId)) {
      return reply.status(400).send({
        error: 'INVALID_ORDER_ID',
        message: 'Order ID must be a valid alphanumeric string up to 128 characters'
      });
    }

    const rateLimit = checkRateLimit(`recover:${merchantId}`, 15, 60000);
    if (!rateLimit.allowed) {
      return reply.status(429).header('Retry-After', rateLimit.retryAfterSeconds.toString()).send({
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many recovery requests. Please wait ${rateLimit.retryAfterSeconds} seconds before retrying.`
      });
    }

    const client = await pool.connect();
    try {
      const result = await getOrderSyncWithHistory(client, merchantId, orderId);
      if (!result) {
        return reply.status(404).send({
          error: 'ORDER_NOT_FOUND',
          message: `No synchronization history found for order ${orderId}`
        });
      }
      return reply.status(200).send(result);
    } finally {
      client.release();
    }
  });

  // 3. Safe Order Recovery Action
  fastify.post('/api/sync/orders/:orderId/recover', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({ error: 'UNAUTHORIZED', message: auth.error });
    }

    const { orderId } = request.params as { orderId: string };
    if (!orderId || typeof orderId !== 'string' || orderId.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(orderId)) {
      return reply.status(400).send({
        error: 'INVALID_ORDER_ID',
        message: 'Order ID must be a valid alphanumeric string up to 128 characters'
      });
    }

    const rateLimit = checkRateLimit(`recover:${merchantId}`, 15, 60000);
    if (!rateLimit.allowed) {
      return reply.status(429).header('Retry-After', rateLimit.retryAfterSeconds.toString()).send({
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many recovery requests. Please wait ${rateLimit.retryAfterSeconds} seconds before retrying.`
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await executeSafeOrderRecovery(client, merchantId, orderId, 'merchant_portal');
      await client.query('COMMIT');

      const statusCode = result.success ? 200 : (result.syncState === 'requires_human_review' ? 422 : 400);
      return reply.status(statusCode).send(result);
    } catch (err: any) {
      await client.query('ROLLBACK');
      return reply.status(500).send({
        orderId,
        success: false,
        error: 'RECOVERY_ERROR',
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  // 4. Support Diagnostics Export (Redacted Secrets & PII)
  fastify.get('/api/sync/orders/:orderId/diagnostics', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({ error: 'UNAUTHORIZED', message: auth.error });
    }

    const { orderId } = request.params as { orderId: string };
    const query = (request.query || {}) as { download?: string };
    const client = await pool.connect();
    try {
      const diagnostics = await generateOrderSupportDiagnostics(client, merchantId, orderId);

      if (query.download === 'true') {
        reply.header('Content-Disposition', `attachment; filename="diagnostics-order-${orderId}.json"`);
        reply.header('Content-Type', 'application/json; charset=utf-8');
      }

      return reply.status(200).send(diagnostics);
    } finally {
      client.release();
    }
  });

  // 5. Active Synchronization Rules Explanation
  fastify.get('/api/sync/rules', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const client = await pool.connect();
    try {
      const tokenRes = await client.query(
        `SELECT store_name, vat_number, cod_fulfillment_statuses, created_at
         FROM merchant_tokens WHERE merchant_id = $1`,
        [merchantId]
      );

      const store = tokenRes.rows[0] || {};
      const subRes = await client.query(
        `SELECT status FROM merchant_subscriptions WHERE merchant_id = $1`,
        [merchantId]
      );
      const isSubActive = subRes.rows.length > 0 && subRes.rows[0].status === 'active';

      const egsRes = await client.query(
        `SELECT id FROM egs_units WHERE merchant_id = $1 AND is_active = true`,
        [merchantId]
      );

      const explanation = getSyncRulesExplanation({
        merchantId,
        storeName: store.store_name,
        vatNumber: store.vat_number,
        codFulfillmentStatuses: store.cod_fulfillment_statuses,
        activeSubscription: isSubActive,
        installedAt: store.created_at ? new Date(store.created_at) : undefined,
        hasActiveEgs: egsRes.rows.length > 0
      });

      return reply.status(200).send(explanation);
    } finally {
      client.release();
    }
  });

  // 6. Pre-Activation Synchronization Preview
  fastify.get('/api/sync/preview', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const client = await pool.connect();
    try {
      const preview = await generateSyncPreview(client, merchantId);
      return reply.status(200).send(preview);
    } finally {
      client.release();
    }
  });

  // 7. Trigger Smart Reconciliation Job
  fastify.post('/api/sync/reconcile', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({ error: 'UNAUTHORIZED', message: auth.error });
    }

    const body = (request.body || {}) as {
      fromDate?: string;
      toDate?: string;
      maxPages?: number;
    };

    const rateLimit = checkRateLimit(`reconcile:${merchantId}`, 5, 60000);
    if (!rateLimit.allowed) {
      return reply.status(429).header('Retry-After', rateLimit.retryAfterSeconds.toString()).send({
        error: 'RATE_LIMIT_EXCEEDED',
        message: `Too many reconciliation jobs requested. Please wait ${rateLimit.retryAfterSeconds} seconds before starting another.`
      });
    }

    if (body.fromDate && isNaN(Date.parse(body.fromDate))) {
      return reply.status(400).send({ error: 'INVALID_FROM_DATE', message: 'fromDate must be a valid ISO 8601 date string' });
    }
    if (body.toDate && isNaN(Date.parse(body.toDate))) {
      return reply.status(400).send({ error: 'INVALID_TO_DATE', message: 'toDate must be a valid ISO 8601 date string' });
    }
    if (body.fromDate && body.toDate && new Date(body.fromDate) > new Date(body.toDate)) {
      return reply.status(400).send({ error: 'INVALID_DATE_RANGE', message: 'fromDate cannot be greater than toDate' });
    }

    const client = await pool.connect();
    try {
      const result = await runStoreReconciliation(client, merchantId, {
        fromDate: body.fromDate,
        toDate: body.toDate,
        maxPages: body.maxPages || 5
      });

      return reply.status(200).send({
        merchant_id: merchantId,
        job_id: result.jobId,
        status: result.status,
        total_scanned: result.totalScanned,
        discrepancies_count: result.discrepanciesCount,
        discrepancies: result.discrepancies
      });
    } finally {
      client.release();
    }
  });

  // 8. Get Latest Reconciliation Status & History
  fastify.get('/api/sync/reconcile/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const merchantId = extractMerchantId(request);
    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({ error: 'UNAUTHORIZED', message: auth.error });
    }

    const client = await pool.connect();
    try {
      const summary = await getLatestReconciliationSummary(client, merchantId);
      return reply.status(200).send({
        merchant_id: merchantId,
        ...summary
      });
    } finally {
      client.release();
    }
  });
}
