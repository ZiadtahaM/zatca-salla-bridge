import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SallaWebhookPayloadSchema, SallaWebhookPayload, SallaOrderData } from '../types/salla.js';
import { verifySallaWebhookSignature } from '../services/webhook-verifier.js';
import { pool } from '../storage/db.js';
import {
  processSallaOrderIntoZatcaInvoice,
  processSallaRefundIntoZatcaCreditNote,
  isB2bCustomer,
  validateB2bBuyerAddress
} from '../services/invoice-generator.js';
import { resolveEgsUnitForOrder } from '../services/branch-router.js';
import {
  storeSallaMerchantTokens,
  getSallaMerchantTokens,
  fetchSallaStoreInfo,
  updateMerchantStoreProfile,
  updateMerchantSubscription,
  isMerchantSubscriptionActive
} from '../services/salla-oauth.js';

export async function sallaWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/webhooks/salla/authorize', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as any;
    const data = body.data || body;

    const merchantId = (body.merchant || data.merchant || body.merchant_id || data.merchant_id || '').toString().trim();
    const accessToken = (data.access_token || body.access_token || '').toString().trim();
    const refreshToken = (data.refresh_token || body.refresh_token || '').toString().trim();
    const expiresIn = Number(data.expires || data.expires_in || body.expires || body.expires_in || 1209600);
    const scope = (data.scope || body.scope || 'offline_access').toString();

    if (!merchantId || !accessToken || !refreshToken) {
      return reply.status(400).send({
        error: 'Missing required Salla OAuth fields (merchant, access_token, refresh_token)'
      });
    }

    const client = await pool.connect();
    try {
      await storeSallaMerchantTokens(client, {
        merchantId,
        accessToken,
        refreshToken,
        expiresIn,
        scope
      });

      // Automatically pre-fetch store profile from Salla API to enable zero-configuration onboarding
      try {
        const storeInfo = await fetchSallaStoreInfo(accessToken);
        if (storeInfo.name || storeInfo.vatNumber || storeInfo.crn || storeInfo.city) {
          await updateMerchantStoreProfile(client, merchantId, {
            storeName: storeInfo.name,
            vatNumber: storeInfo.vatNumber,
            crn: storeInfo.crn,
            city: storeInfo.city
          });
        }
      } catch {
        // Non-blocking in offline or test environments
      }

      // Initialize automatic 14-day trial subscription if no active subscription exists
      await updateMerchantSubscription(client, merchantId, 'standard', 'active');

      return reply.status(200).send({
        status: 'authorized',
        merchant_id: merchantId
      });
    } finally {
      client.release();
    }
  });

  fastify.get('/api/salla/merchants/:merchantId/tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const { merchantId } = request.params as { merchantId: string };
    const client = await pool.connect();
    try {
      const tokens = await getSallaMerchantTokens(client, merchantId);
      if (!tokens) {
        return reply.status(404).send({ error: `No OAuth tokens found for merchant ${merchantId}` });
      }
      return reply.status(200).send({
        merchant_id: tokens.merchantId,
        expires_at: tokens.expiresAt.toISOString(),
        scope: tokens.scope,
        store_name: tokens.storeName,
        vat_number: tokens.vatNumber,
        crn: tokens.crn,
        city: tokens.city
      });
    } finally {
      client.release();
    }
  });

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
    const merchantId = payload.merchant.toString();

    const client = await pool.connect();
    try {
      // Handle Salla App Store Billing Lifecycle Events
      if (payload.event.startsWith('app.subscription.') || payload.event === 'app.uninstalled') {
        const subData = (payload.data || {}) as any;
        const planName = (subData.plan_name || 'standard').toString();
        let status = 'active';

        if (payload.event === 'app.uninstalled') {
          status = 'uninstalled';
        } else if (payload.event === 'app.subscription.expired') {
          status = 'expired';
        } else if (payload.event === 'app.subscription.canceled') {
          status = 'canceled';
        } else if (payload.event === 'app.subscription.started' || payload.event === 'app.subscription.renewed') {
          status = 'active';
        }

        const expiresAt = subData.expires_at ? new Date(subData.expires_at) : null;
        await updateMerchantSubscription(client, merchantId, planName, status, expiresAt);

        return reply.status(200).send({
          status: 'subscription_updated',
          merchant_id: merchantId,
          subscription_status: status
        });
      }

      // Enforce active subscription check before processing orders
      const subCheck = await isMerchantSubscriptionActive(client, merchantId);
      if (!subCheck.active) {
        return reply.status(402).send({
          error: 'PAYMENT_REQUIRED',
          code: 'SUBSCRIPTION_INACTIVE',
          message: subCheck.reason || 'Merchant subscription is inactive, expired, or canceled. Please renew on Salla App Store.'
        });
      }

      const isRefundOrCancel = payload.event === 'order.refunded' || payload.event === 'order.cancelled';
      const isOrderUpsert = payload.event === 'order.created' || payload.event === 'order.updated';

      if (!isRefundOrCancel && !isOrderUpsert) {
        return reply.status(200).send({ message: `Ignored event: ${payload.event}` });
      }

      const orderData = payload.data as SallaOrderData;
      const orderId = orderData.id.toString();
      const idempotencyKey = `salla:${merchantId}:${payload.event}:${orderId}:${payload.created_at}`;

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

      const sallaBranchId = (payload.data as any).branch_id?.toString() || (payload.data as any).shipping?.branch_id?.toString();
      const terminalId = (payload.data as any).terminal_id?.toString();

      let resolvedUnit;
      try {
        resolvedUnit = await resolveEgsUnitForOrder(client, {
          merchantId,
          sallaBranchId,
          terminalId
        });
      } catch (err: any) {
        return reply.status(422).send({
          error: `No active EGS unit registered for Salla merchant: ${merchantId}`
        });
      }

      const egsUnitId = resolvedUnit.id;

      if (isOrderUpsert) {
        const existingOrderInvoice = await client.query(
          `SELECT id, uuid, icv, invoice_hash, qr_code_payload, status 
           FROM invoices 
           WHERE order_id = $1 AND egs_unit_id = $2
             AND invoice_type IN ('simplified_tax_invoice', 'tax_invoice')
           ORDER BY created_at DESC LIMIT 1`,
          [orderId, egsUnitId]
        );

        if (existingOrderInvoice.rows.length > 0) {
          const inv = existingOrderInvoice.rows[0];
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

        const paymentMethod = orderData.payment_method?.toLowerCase() || '';
        const statusSlug = orderData.status?.slug?.toLowerCase() || '';
        const isDeferredPaymentMethod = ['cod', 'cash_on_delivery', 'bank', 'bank_transfer'].includes(paymentMethod);
        const isFinalizedStatus = ['completed', 'delivered'].includes(statusSlug);

        if (isDeferredPaymentMethod && !isFinalizedStatus) {
          return reply.status(200).send({
            status: 'deferred_payment_hold',
            order_id: orderId,
            payment_method: orderData.payment_method,
            order_status: orderData.status?.slug,
            reason: 'COD and Bank Transfer orders are deferred until status reaches completed or delivered'
          });
        }

        if (isB2bCustomer(orderData.customer?.tax_number)) {
          const validation = validateB2bBuyerAddress(orderData);
          if (!validation.isValid) {
            const buyerVat = orderData.customer.tax_number!.trim();
            const buyerName = (
              orderData.customer.company_name ||
              `${orderData.customer.first_name} ${orderData.customer.last_name || ''}`
            ).trim();

            const pendingRes = await client.query(
              `INSERT INTO pending_b2b_orders (
                merchant_id, order_id, idempotency_key, egs_unit_id,
                buyer_vat, buyer_name, order_payload, missing_fields, status
              ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'pending_enrichment')
              ON CONFLICT (idempotency_key) DO UPDATE SET
                missing_fields = EXCLUDED.missing_fields,
                order_payload = EXCLUDED.order_payload,
                updated_at = NOW()
              RETURNING id`,
              [
                merchantId,
                orderId,
                idempotencyKey,
                egsUnitId,
                buyerVat,
                buyerName,
                JSON.stringify(orderData),
                JSON.stringify(validation.missingFields)
              ]
            );

            return reply.status(200).send({
              status: 'pending_b2b_enrichment',
              pending_id: pendingRes.rows[0].id,
              order_id: orderId,
              missing_fields: validation.missingFields,
              enrichment_url: `/api/b2b/orders/${orderId}/enrich`
            });
          }
        }
      }

      let result;
      if (isRefundOrCancel) {
        result = await processSallaRefundIntoZatcaCreditNote(
          client,
          egsUnitId,
          orderData,
          idempotencyKey,
          payload.event === 'order.cancelled' ? 'Order cancelled by customer or merchant' : 'Order refunded'
        );
      } else {
        result = await processSallaOrderIntoZatcaInvoice(
          client,
          egsUnitId,
          orderData,
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

  fastify.post('/api/b2b/orders/:orderId/enrich', async (request: FastifyRequest, reply: FastifyReply) => {
    const { orderId } = request.params as { orderId: string };
    const body = (request.body || {}) as {
      building_number?: string;
      postal_code?: string;
      street?: string;
      district?: string;
      city?: string;
      company_name?: string;
      buyer_vat?: string;
      country?: string;
    };

    const client = await pool.connect();
    try {
      const pendingRes = await client.query(
        `SELECT id, merchant_id, order_id, idempotency_key, egs_unit_id, order_payload, status
         FROM pending_b2b_orders
         WHERE order_id = $1 AND status = 'pending_enrichment'
         ORDER BY created_at DESC LIMIT 1`,
        [orderId]
      );

      if (pendingRes.rows.length === 0) {
        return reply.status(404).send({
          error: `No pending B2B order awaiting enrichment found for order_id: ${orderId}`
        });
      }

      const pendingRow = pendingRes.rows[0];
      const rawOrder: SallaOrderData =
        typeof pendingRow.order_payload === 'string'
          ? JSON.parse(pendingRow.order_payload)
          : pendingRow.order_payload;

      const existingAddress = rawOrder.shipping?.address || { country: 'SA', city: 'Riyadh' };
      const updatedOrder: SallaOrderData = {
        ...rawOrder,
        customer: {
          ...rawOrder.customer,
          company_name: body.company_name !== undefined ? body.company_name : rawOrder.customer.company_name,
          tax_number: body.buyer_vat !== undefined ? body.buyer_vat : rawOrder.customer.tax_number
        },
        shipping: {
          ...(rawOrder.shipping || {}),
          address: {
            ...existingAddress,
            country: body.country || existingAddress.country || 'SA',
            building_number: body.building_number !== undefined ? body.building_number : existingAddress.building_number,
            postal_code: body.postal_code !== undefined ? body.postal_code : existingAddress.postal_code,
            street: body.street !== undefined ? body.street : existingAddress.street,
            district: body.district !== undefined ? body.district : existingAddress.district,
            city: body.city !== undefined ? body.city : existingAddress.city
          }
        }
      };

      const validation = validateB2bBuyerAddress(updatedOrder);
      if (!validation.isValid) {
        return reply.status(400).send({
          error: 'Incomplete B2B national address',
          missing_fields: validation.missingFields
        });
      }

      const result = await processSallaOrderIntoZatcaInvoice(
        client,
        pendingRow.egs_unit_id,
        updatedOrder,
        `${pendingRow.idempotency_key}:enriched`
      );

      await client.query(
        `UPDATE pending_b2b_orders
         SET status = 'enriched_and_signed',
             buyer_vat = COALESCE($2, buyer_vat),
             buyer_name = COALESCE($3, buyer_name),
             updated_at = NOW()
         WHERE id = $1`,
        [pendingRow.id, body.buyer_vat || null, body.company_name || null]
      );

      return reply.status(200).send({
        status: 'enriched_and_signed',
        order_id: orderId,
        invoice_id: result.invoiceId,
        invoice_uuid: result.invoiceUuid,
        icv: result.icv,
        invoice_hash: result.invoiceHash,
        qr_code: result.qrCodeBase64
      });
    } finally {
      client.release();
    }
  });
}
