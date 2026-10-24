import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { pool } from '../storage/db.js';
import { checkCsidExpirations, getMerchantCsidStatus } from '../services/csid-renewal-worker.js';
import { checkStalledDlqInvoices, resolveDlqInvoice } from '../services/dlq-monitor.js';
import { encryptVaultSecret, decryptVaultSecret } from '../crypto/vault.js';

export const opsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Check upcoming CSID certificate expirations across all merchant branches
  app.get('/api/egs/expiry-check', async (request, reply) => {
    const thresholdDays = parseInt((request.query as any)?.days || '7', 10);
    const result = await checkCsidExpirations(pool, thresholdDays);
    return reply.status(200).send(result);
  });

  // Get CSID health and expiration for a specific merchant
  app.get('/api/egs/expiry-status/:merchantId', async (request, reply) => {
    const { merchantId } = request.params as { merchantId: string };
    const status = await getMerchantCsidStatus(pool, merchantId);
    return reply.status(200).send({ merchantId, units: status });
  });

  // Check stalled invoices in the Dead Letter Queue (> 30 minutes)
  app.get('/api/dlq/stalled', async (request, reply) => {
    const thresholdMinutes = parseInt((request.query as any)?.minutes || '30', 10);
    const alerts = await checkStalledDlqInvoices(pool, thresholdMinutes);
    return reply.status(200).send({
      stalledCount: alerts.length,
      thresholdMinutes,
      alerts
    });
  });

  // Resolve a DLQ item after successful retry or manual intervention
  app.post('/api/dlq/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const resolved = await resolveDlqInvoice(pool, id);
    if (!resolved) {
      return reply.status(404).send({ error: 'DLQ item not found or already resolved' });
    }
    return reply.status(200).send({ status: 'resolved', dlqId: id });
  });

  // Automated AES-256-GCM encrypted backup snapshot exporter for 7-year audit law compliance
  app.get('/api/ops/backup', async (request, reply) => {
    const merchantId = (request.query as any)?.merchantId;
    const client = await pool.connect();
    try {
      const egsQuery = merchantId
        ? `SELECT * FROM egs_units WHERE merchant_id = $1 ORDER BY created_at ASC`
        : `SELECT * FROM egs_units ORDER BY created_at ASC`;
      const egsParams = merchantId ? [merchantId] : [];
      const egsRes = await client.query(egsQuery, egsParams);

      const invQuery = merchantId
        ? `SELECT i.* FROM invoices i JOIN egs_units e ON i.egs_unit_id = e.id WHERE e.merchant_id = $1 ORDER BY i.created_at ASC`
        : `SELECT * FROM invoices ORDER BY created_at ASC`;
      const invParams = merchantId ? [merchantId] : [];
      const invRes = await client.query(invQuery, invParams);

      const tokQuery = merchantId
        ? `SELECT * FROM merchant_tokens WHERE merchant_id = $1`
        : `SELECT * FROM merchant_tokens ORDER BY created_at ASC`;
      const tokParams = merchantId ? [merchantId] : [];
      const tokRes = await client.query(tokQuery, tokParams);

      const snapshot = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        merchantId: merchantId || 'ALL',
        recordCounts: {
          egsUnits: egsRes.rows.length,
          invoices: invRes.rows.length,
          merchantTokens: tokRes.rows.length
        },
        data: {
          egsUnits: egsRes.rows,
          invoices: invRes.rows,
          merchantTokens: tokRes.rows
        }
      };

      const snapshotJson = JSON.stringify(snapshot);
      const checksumSha256 = createHash('sha256').update(snapshotJson).digest('hex');
      const encryptedPayload = encryptVaultSecret(snapshotJson);

      return reply.status(200).send({
        success: true,
        exportedAt: snapshot.exportedAt,
        recordCounts: snapshot.recordCounts,
        checksumSha256,
        encryptedPayload
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: 'BACKUP_EXPORT_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  // Automated AES-256-GCM encrypted backup snapshot validator
  app.post('/api/ops/backup/verify', async (request, reply) => {
    const { encryptedPayload, expectedChecksum } = (request.body as any) || {};
    if (!encryptedPayload) {
      return reply.status(400).send({
        error: 'INVALID_PAYLOAD',
        message: 'encryptedPayload is required'
      });
    }

    try {
      const decryptedJson = decryptVaultSecret(encryptedPayload);
      const snapshot = JSON.parse(decryptedJson);
      const computedChecksum = createHash('sha256').update(decryptedJson).digest('hex');
      const checksumMatched = expectedChecksum ? computedChecksum === expectedChecksum : true;

      return reply.status(200).send({
        success: true,
        valid: true,
        exportedAt: snapshot.exportedAt,
        recordCounts: snapshot.recordCounts,
        computedChecksum,
        checksumMatched
      });
    } catch (err: any) {
      return reply.status(400).send({
        error: 'BACKUP_VERIFICATION_FAILED',
        valid: false,
        message: err.message
      });
    }
  });
};
