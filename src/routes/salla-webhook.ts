import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SallaWebhookPayloadSchema, SallaWebhookPayload } from '../types/salla.js';
import { verifySallaWebhookSignature } from '../services/webhook-verifier.js';
import { pool } from '../storage/db.js';
import { processSallaOrderIntoZatcaInvoice, processSallaRefundIntoZatcaCreditNote } from '../services/invoice-generator.js';

export async function sallaWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhooks/salla', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBodyBuffer = (request as any).rawBody as Buffer | undefined;

    if (!rawBodyBuffer) {
      return reply.status(400).send({ error: 'Missing raw request body buffer' });
    }

    const signatureHeader = request.headers['x-salla-signature'] as string | undefined;
    const webhookSecret = process.env.SALLA_WEBHOOK_SECRET || 'dev_salla_webhook_secret';

    const isValid = verifySallaWebhookSignature(rawBodyBuffer, signatureHeader, webhookSecret);
    if (!isValid && process.env.NODE_ENV === 'production') {
      return reply.status(401).send({ error: 'Invalid HMAC signature in x-salla-signature header' });
    }

    const parseResult = SallaWebhookPayloadSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Schema validation failed for Salla webhook payload',
        details: parseResult.error.errors
      });
    }

    const payload: SallaWebhookPayload = parseResult.data;

    const isRefundOrCancel = payload.event === 'order.refunded' || payload.event === 'order.cancelled';
    const isOrderUpsert = payload.event === 'order.created' || payload.event === 'order.updated';

    if (!isRefundOrCancel && !isOrderUpsert) {
      return reply.status(200).send({ message: `Ignored event: ${payload.event}` });
    }

    const merchantId = payload.merchant.toString();
    const orderId = payload.data.id.toString();
    const idempotencyKey = `salla:${merchantId}:${payload.event}:${orderId}:${payload.created_at}`;

    const client = await pool.connect();
    try {
      const existing = await client.query(
        `SELECT id, uuid, icv, invoice_hash, qr_code_payload, status 
         FROM invoices 
         WHERE idempotency_key = $1`,
        [idempotencyKey]
      );

      if (existing.rows.length > 0) {
        const inv = existing.rows[0];
        return reply.status(200).send({
          status: 'idempotent_replay',
          invoice_id: inv.id,
          invoice_uuid: inv.uuid,
          icv: inv.icv,
          invoice_hash: inv.invoice_hash,
          qr_code: inv.qr_code_payload,
          invoice_status: inv.status
        });
      }

      const egsRes = await client.query(
        `SELECT id FROM egs_units 
         WHERE merchant_id = $1 AND is_active = TRUE 
         LIMIT 1`,
        [merchantId]
      );

      if (egsRes.rows.length === 0) {
        return reply.status(422).send({
          error: `No active EGS unit registered for Salla merchant: ${merchantId}`
        });
      }

      const egsUnitId = egsRes.rows[0].id;

      let result;
      if (isRefundOrCancel) {
        result = await processSallaRefundIntoZatcaCreditNote(
          client,
          egsUnitId,
          payload.data,
          idempotencyKey,
          payload.event === 'order.cancelled' ? 'Order cancelled by customer or merchant' : 'Order refunded'
        );
      } else {
        result = await processSallaOrderIntoZatcaInvoice(
          client,
          egsUnitId,
          payload.data,
          idempotencyKey
        );
      }

      return reply.status(200).send({
        status: isRefundOrCancel ? 'credit_note_issued' : 'signed_and_recorded',
        order_id: orderId,
        invoice_id: result.invoiceId,
        invoice_uuid: result.invoiceUuid,
        icv: result.icv,
        invoice_hash: result.invoiceHash,
        qr_code: result.qrCodeBase64,
        is_b2c: result.isB2C,
        document_type: isRefundOrCancel ? 'credit_note' : (result.isB2C ? 'simplified_tax_invoice' : 'tax_invoice'),
        zatca_status: result.isB2C ? 'ready_for_reporting_24h' : 'queued_for_clearance'
      });
    } finally {
      client.release();
    }
  });
}
