import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { pool } from '../storage/db.js';
import { checkCsidExpirations, getMerchantCsidStatus } from '../services/csid-renewal-worker.js';
import { checkStalledDlqInvoices, resolveDlqInvoice } from '../services/dlq-monitor.js';

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
};
