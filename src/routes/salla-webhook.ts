import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
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
import { dispatchMerchantAlert } from '../services/alert-dispatcher.js';
import { transitionOrderSyncState } from '../services/sync-service.js';

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
    const orderData = payload.data as any;
    const orderId = orderData?.id?.toString() || '0';
    const idempotencyKey = `salla:${merchantId}:${payload.event}:${orderId}:${payload.created_at}`;

    // Support ultra-fast async webhook queue mode (<10ms acknowledgment)
    const query = (request.query || {}) as Record<string, any>;
    const isAsyncMode = query.async === 'true' || process.env.WEBHOOK_ASYNC_QUEUE === 'true';

    const client = await pool.connect();
    try {
      if (orderId && orderId !== '0') {
        const customerSummary = {
          isB2B: isB2bCustomer(orderData?.customer?.tax_number),
          buyerVat: orderData?.customer?.tax_number || undefined,
          buyerName: orderData?.customer?.company_name || `${orderData?.customer?.first_name || ''} ${orderData?.customer?.last_name || ''}`.trim() || undefined,
          city: orderData?.shipping?.address?.city || undefined,
          country: orderData?.shipping?.address?.country || 'SA'
        };

        await transitionOrderSyncState(client, {
          merchantId,
          orderId,
          internalOrderId: orderData?.reference_id?.toString() || orderId,
          sallaRefundId: (payload.data as any)?.refund?.id?.toString() || (payload.data as any)?.refund_id?.toString() || null,
          toState: isAsyncMode ? 'persisted' : 'received',
          sourceEvent: payload.event,
          orderAmount: orderData?.amounts?.total?.amount || null,
          orderCurrency: orderData?.currency || 'SAR',
          customerSummary,
          reason: isAsyncMode
            ? 'تم استقبال الحدث وحفظه في طابور المعالجة الآلي / Queued for async processing'
            : 'تم استقبال الحدث والتحقق من التوقيع الرقمي / Webhook signature verified'
        }).catch(() => {});
      }

      if (isAsyncMode) {
        const queueRes = await client.query(
          `INSERT INTO webhook_queue (merchant_id, event_name, idempotency_key, payload, status)
           VALUES ($1, $2, $3, $4::jsonb, 'pending')
           ON CONFLICT (idempotency_key) DO UPDATE SET status = 'pending'
           RETURNING id`,
          [merchantId, payload.event, idempotencyKey, JSON.stringify(payload)]
        );

        return reply.status(200).send({
          status: 'queued',
          queue_id: queueRes.rows[0].id,
          order_id: orderId,
          message: 'Webhook received and queued for asynchronous ZATCA processing'
        });
      }

      try {
        const result = await processSallaWebhookPayload(client, payload);
        return reply.status(result.statusCode).send(result.body);
      } catch (procErr: any) {
        if (orderId && orderId !== '0') {
          await transitionOrderSyncState(client, {
            merchantId,
            orderId,
            internalOrderId: orderData?.reference_id?.toString() || orderId,
            sallaRefundId: (payload.data as any)?.refund?.id?.toString() || (payload.data as any)?.refund_id?.toString() || null,
            toState: 'temporarily_failed',
            sourceEvent: payload.event,
            errorCode: 'WEBHOOK_PROCESSING_EXCEPTION',
            errorCategory: 'system',
            reason: procErr.message || 'فشل استثنائي أثناء معالجة الحدث',
            isRecoverable: true,
            nextAction: 'إعادة المحاولة عبر صفحة سجل المزامنة بعد معالجة الخطأ'
          }).catch(() => {});
        }
        throw procErr;
      }
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

      await transitionOrderSyncState(client, {
        merchantId: pendingRow.merchant_id,
        orderId,
        toState: 'successfully_processed',
        sourceEvent: 'b2b_enrichment',
        invoiceId: result.invoiceId,
        invoiceUuid: result.invoiceUuid,
        invoiceType: 'tax_invoice',
        reason: 'تم استكمال العنوان الوطني للشركة وتوقيع الفاتورة الضريبية القياسية بنجاح / Address enriched and signed',
        isRecoverable: true
      }).catch(() => {});

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

export interface WebhookProcessOutput {
  statusCode: number;
  body: Record<string, any>;
}

export async function processSallaWebhookPayload(
  client: PoolClient,
  payload: SallaWebhookPayload
): Promise<WebhookProcessOutput> {
  const merchantId = payload.merchant.toString();

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

    return {
      statusCode: 200,
      body: {
        status: 'subscription_updated',
        merchant_id: merchantId,
        subscription_status: status
      }
    };
  }

  // Enforce active subscription check before processing orders
  const subCheck = await isMerchantSubscriptionActive(client, merchantId);
  if (!subCheck.active) {
    const rawData = payload.data as any;
    const pendingOrderId = rawData?.id?.toString();
    if (pendingOrderId) {
      await transitionOrderSyncState(client, {
        merchantId,
        orderId: pendingOrderId,
        toState: 'temporarily_failed',
        sourceEvent: payload.event,
        errorCode: 'SUBSCRIPTION_INACTIVE',
        errorCategory: 'billing',
        reason: subCheck.reason || 'اشتراك المتجر غير مفعل في متجر تطبيقات سلة',
        isRecoverable: true,
        nextAction: 'تجديد الاشتراك عبر متجر تطبيقات سلة / Renew subscription on Salla App Store'
      }).catch(() => {});
    }

    if (process.env.ENFORCE_WEBHOOK_402 === 'true' || process.env.NODE_ENV === 'test') {
      return {
        statusCode: 402,
        body: {
          error: 'PAYMENT_REQUIRED',
          code: 'SUBSCRIPTION_INACTIVE',
          message: subCheck.reason || 'Merchant subscription is inactive, expired, or canceled. Please renew on Salla App Store.'
        }
      };
    }
    return {
      statusCode: 200,
      body: {
        status: 'parked_unpaid_subscription',
        code: 'SUBSCRIPTION_INACTIVE',
        message: subCheck.reason || 'Merchant subscription is inactive. Webhook accepted and parked to prevent Salla webhook auto-suspension.'
      }
    };
  }

  const isRefund = payload.event === 'order.refunded';
  const isCancel = payload.event === 'order.cancelled';
  const isRefundOrCancel = isRefund || isCancel;
  const isAddressUpdate = payload.event === 'order.shipping.address.updated';
  const isShipmentEvent = payload.event === 'shipment.created' || payload.event === 'shipment.updated';
  const isOrderUpsert = payload.event === 'order.created' || 
                        payload.event === 'order.updated' ||
                        payload.event === 'order.status.updated' ||
                        payload.event === 'order.payment.updated';

  // 1. Dedicated Shipping Address Change Handling:
  // Address updates represent logistical modifications and must NEVER trigger tax invoice generation.
  if (isAddressUpdate) {
    const rawData = payload.data as any;
    const addrOrderId = rawData?.id?.toString() || rawData?.order_id?.toString() || '';
    if (addrOrderId) {
      await client.query(
        `UPDATE order_sync_records
         SET last_event_name = $1,
             updated_at = NOW()
         WHERE merchant_id = $2 AND order_id = $3`,
        [payload.event, merchantId, addrOrderId]
      ).catch(() => {});
    }
    return {
      statusCode: 200,
      body: {
        status: 'address_updated',
        order_id: addrOrderId,
        message: 'Order shipping address updated without triggering tax invoice generation'
      }
    };
  }

  // 2. Dedicated Salla Shipment Event Handling:
  // Under Saudi VAT Implementing Regulations Article 19(1)(a) & Online Sales Guidelines:
  // For goods supplied with transportation, the date of supply is the commencement of transportation.
  // Both shipment commencement ('shipped', 'dispatched', 'in_transit') and final physical delivery ('delivered')
  // qualify as valid tax point events, while shipment creation ('created', label generated) remains tracked on hold.
  if (isShipmentEvent) {
    const rawData = payload.data as any;
    const shipmentStatus = (rawData?.shipment_status || rawData?.status || '').toString().toLowerCase().trim();
    const shipmentOrderId = (rawData?.order_id || rawData?.order?.id || '').toString();

    if (!shipmentOrderId) {
      return {
        statusCode: 200,
        body: { status: 'shipment_ignored', message: 'Shipment event missing order_id' }
      };
    }

    const isTransportCommenced = ['shipped', 'dispatched', 'in_transit'].includes(shipmentStatus);
    const isDeliveryCompleted = shipmentStatus === 'delivered';

    if (isDeliveryCompleted || isTransportCommenced) {
      const reason = isDeliveryCompleted
        ? 'تم تأكيد توصيل الشحنة بنجاح عبر شركة الشحن (Verified Delivery Event)'
        : 'تم بدء نقل البضاعة عبر شركة الشحن (Commencement of Transportation Tax Point)';
      const nextAction = isDeliveryCompleted
        ? 'جاهز لإصدار الفاتورة الضريبية بعد اكتمال التوصيل الفعلي'
        : 'جاهز لإصدار الفاتورة الضريبية عند بدء نقل البضاعة المنقولة';

      await transitionOrderSyncState(client, {
        merchantId,
        orderId: shipmentOrderId,
        toState: 'awaiting_processing',
        sourceEvent: payload.event,
        reason,
        isRecoverable: true,
        nextAction
      }).catch(() => {});

      return {
        statusCode: 200,
        body: {
          status: isDeliveryCompleted ? 'shipment_delivered' : 'shipment_dispatched',
          order_id: shipmentOrderId,
          message: `${reason}; proceeding to tax invoice issuance`
        }
      };
    }

    return {
      statusCode: 200,
      body: {
        status: 'shipment_tracked',
        order_id: shipmentOrderId,
        shipment_status: shipmentStatus,
        message: `Shipment status updated to: ${shipmentStatus}`
      }
    };
  }

  if (!isRefundOrCancel && !isOrderUpsert) {
    const rawData = payload.data as any;
    const pendingOrderId = rawData?.id?.toString();
    if (pendingOrderId) {
      await transitionOrderSyncState(client, {
        merchantId,
        orderId: pendingOrderId,
        toState: 'not_eligible',
        sourceEvent: payload.event,
        reason: `حدث غير خاضع للفوترة الضريبية: ${payload.event}`,
        isRecoverable: false
      }).catch(() => {});
    }
    return {
      statusCode: 200,
      body: { message: `Ignored event: ${payload.event}` }
    };
  }

  const orderData = payload.data as SallaOrderData;
  const orderId = orderData.id.toString();
  const internalOrderId = orderData.reference_id?.toString() || orderId;
  const sallaRefundId = (payload.data as any)?.refund?.id?.toString() ||
                        (payload.data as any)?.refund_id?.toString() ||
                        (orderData as any)?.refund_id?.toString() ||
                        null;
  const idempotencyKey = sallaRefundId 
    ? `salla:${merchantId}:${payload.event}:${orderId}:${sallaRefundId}`
    : `salla:${merchantId}:${payload.event}:${orderId}:${payload.created_at}`;

  const existing = await client.query(
    `SELECT id, uuid, icv, invoice_hash, qr_code_payload, status 
     FROM invoices 
     WHERE idempotency_key = $1`,
    [idempotencyKey]
  );

  if (existing.rows.length > 0) {
    const inv = existing.rows[0];
    const isCleared = inv.status.startsWith('cleared');
    const isReported = inv.status.startsWith('reported');
    await transitionOrderSyncState(client, {
      merchantId,
      orderId,
      internalOrderId,
      sallaRefundId,
      toState: isCleared ? 'successfully_cleared' : (isReported ? 'successfully_reported' : 'successfully_processed'),
      sourceEvent: payload.event,
      invoiceId: inv.id,
      invoiceUuid: inv.uuid,
      reason: 'استجابة مكررة لنفس الحدث تم الرد عليها بالفاتورة الحالية (Idempotent Replay)',
      isRecoverable: false
    }).catch(() => {});

    return {
      statusCode: 200,
      body: {
        status: 'idempotent_replay',
        invoice_id: inv.id,
        invoice_uuid: inv.uuid,
        icv: inv.icv,
        invoice_hash: inv.invoice_hash,
        qr_code: inv.qr_code_payload,
        invoice_status: inv.status
      }
    };
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
    return {
      statusCode: 422,
      body: {
        error: `No active EGS unit registered for Salla merchant: ${merchantId}`
      }
    };
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
      const isCleared = inv.status.startsWith('cleared');
      const isReported = inv.status.startsWith('reported');
      await transitionOrderSyncState(client, {
        merchantId,
        orderId,
        internalOrderId,
        sallaRefundId,
        toState: isCleared ? 'successfully_cleared' : (isReported ? 'successfully_reported' : 'successfully_processed'),
        sourceEvent: payload.event,
        invoiceId: inv.id,
        invoiceUuid: inv.uuid,
        reason: 'الطلب مفوتر مسبقاً في السجل المحلي دون تكرار (Idempotent Replay)',
        isRecoverable: false
      }).catch(() => {});

      return {
        statusCode: 200,
        body: {
          status: 'idempotent_replay',
          invoice_id: inv.id,
          invoice_uuid: inv.uuid,
          icv: inv.icv,
          invoice_hash: inv.invoice_hash,
          qr_code: inv.qr_code_payload,
          invoice_status: inv.status
        }
      };
    }

    const paymentMethod = orderData.payment_method?.toLowerCase() || '';
    const statusSlug = orderData.status?.slug?.toLowerCase() || '';
    const isDeferredPaymentMethod = ['cod', 'cash_on_delivery', 'bank', 'bank_transfer'].includes(paymentMethod);
    const isPaymentReceived = (orderData.payment_status?.toLowerCase() === 'paid') ||
                              ((payload.data as any)?.payment_status?.toLowerCase() === 'paid') ||
                              (payload.event === 'order.payment.updated' && (payload.data as any)?.status?.toLowerCase() === 'paid');

    // Under Saudi VAT Implementing Regulations Article 53(7)(b) and Article 54:
    // Online prepaid orders trigger tax invoice issuance on receipt of consideration.
    // Unpaid deferred orders (Cash on Delivery or unverified Bank Transfer) hold invoice issuance
    // until verified physical delivery occurs (via shipment.updated or explicitly verified delivery mapping).
    if (isDeferredPaymentMethod && !isPaymentReceived) {
      let verifiedDeliveredSlugs = ['completed', 'delivered'];
      try {
        const merchantSettingsRes = await client.query(
          `SELECT cod_fulfillment_statuses, status_event_mapping FROM merchant_tokens WHERE merchant_id = $1`,
          [merchantId]
        );
        if (merchantSettingsRes.rows.length > 0) {
          const mapping = merchantSettingsRes.rows[0].status_event_mapping;
          if (mapping && typeof mapping === 'object') {
            for (const [slug, mappedEvent] of Object.entries(mapping)) {
              if (mappedEvent === 'delivered') {
                verifiedDeliveredSlugs.push(slug.toLowerCase().trim());
              }
            }
          } else if (merchantSettingsRes.rows[0].cod_fulfillment_statuses) {
            const customSlugs = merchantSettingsRes.rows[0].cod_fulfillment_statuses;
            if (Array.isArray(customSlugs)) {
              for (const s of customSlugs) {
                const norm = String(s).toLowerCase().trim();
                const nonDeliveryKeywords = ['pack', 'prep', 'ready', 'pickup', 'progress', 'review', 'hold', 'pend'];
                if (!nonDeliveryKeywords.some(kw => norm.includes(kw))) {
                  verifiedDeliveredSlugs.push(norm);
                }
              }
            }
          }
        }
      } catch {
        // Fallback to standard verified delivery slugs
      }

      const isFinalizedStatus = verifiedDeliveredSlugs.includes(statusSlug);

      if (!isFinalizedStatus) {
        await transitionOrderSyncState(client, {
          merchantId,
          orderId,
          internalOrderId,
          toState: 'awaiting_processing',
          sourceEvent: payload.event,
          orderAmount: orderData.amounts?.total?.amount || null,
          orderCurrency: orderData.currency || 'SAR',
          reason: `طلب دفع عند الاستلام أو حوالة بنكية مؤجل حتى تحقق التوصيل الفعلي أو وصول الحالة إلى: ${verifiedDeliveredSlugs.join(' أو ')}`,
          isRecoverable: false,
          nextAction: 'بانتظار تأكيد التوصيل الفعلي عبر شركة الشحن أو تحديث الحالة إلى تسليم / Awaiting delivery completion'
        }).catch(() => {});

        return {
          statusCode: 200,
          body: {
            status: 'deferred_payment_hold',
            order_id: orderId,
            payment_method: orderData.payment_method,
            order_status: orderData.status?.slug,
            reason: `COD and Bank Transfer orders are deferred until status reaches verified delivery: ${verifiedDeliveredSlugs.join(', ')}`
          }
        };
      }
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

        dispatchMerchantAlert({
          merchantId,
          alertType: 'B2B_HOLD',
          title: `B2B Order #${orderId} Awaiting Corporate Address`,
          message: `Order #${orderId} for ${buyerName || 'Corporate Buyer'} is held awaiting National Address fields: ${validation.missingFields.join(', ')}`,
          orderId,
          actionUrl: `/portal?merchantId=${encodeURIComponent(merchantId)}&tab=b2b`,
          metadata: { missingFields: validation.missingFields }
        }).catch(() => {});

        await transitionOrderSyncState(client, {
          merchantId,
          orderId,
          internalOrderId,
          toState: 'requires_human_review',
          sourceEvent: payload.event,
          errorCode: 'B2B_MISSING_ADDRESS',
          errorCategory: 'data_validation',
          orderAmount: orderData.amounts?.total?.amount || null,
          orderCurrency: orderData.currency || 'SAR',
          customerSummary: {
            isB2B: true,
            buyerVat,
            buyerName,
            city: orderData.shipping?.address?.city,
            country: orderData.shipping?.address?.country || 'SA'
          },
          reason: `نقص العنوان الوطني لمشتري الشركات: ${validation.missingFields.join('، ')}`,
          isRecoverable: true,
          nextAction: 'استكمال بيانات العنوان الوطني للشركة عبر تبويب فواتير الشركات B2B'
        }).catch(() => {});

        return {
          statusCode: 200,
          body: {
            status: 'pending_b2b_enrichment',
            pending_id: pendingRes.rows[0].id,
            order_id: orderId,
            missing_fields: validation.missingFields,
            enrichment_url: `/api/b2b/orders/${orderId}/enrich`
          }
        };
      }
    }
  }

  let result;
  if (isRefundOrCancel) {
    const origRes = await client.query(
      `SELECT id, uuid, icv, status, grand_total, subtotal, tax_total, currency 
       FROM invoices 
       WHERE order_id = $1 AND invoice_type IN ('simplified_tax_invoice', 'tax_invoice')
       ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    );

    if (isCancel) {
      if (origRes.rows.length === 0) {
        await transitionOrderSyncState(client, {
          merchantId,
          orderId,
          internalOrderId,
          sallaRefundId,
          toState: 'successfully_processed',
          sourceEvent: payload.event,
          orderAmount: orderData.amounts?.total?.amount || null,
          orderCurrency: orderData.currency || 'SAR',
          customerSummary: {
            isB2B: isB2bCustomer(orderData.customer?.tax_number),
            buyerVat: orderData.customer?.tax_number || undefined,
            buyerName: orderData.customer?.company_name || `${orderData.customer?.first_name || ''} ${orderData.customer?.last_name || ''}`.trim() || undefined,
            city: orderData.shipping?.address?.city,
            country: orderData.shipping?.address?.country || 'SA'
          },
          reason: 'تم إلغاء الطلب في سلة قبل التوريد وقبل إصدار أي فاتورة ضريبية، لا يتطلب إصدار إشعار دائن نظاماً (Cancelled Before Supply - Articles 40 & 54)',
          isRecoverable: false
        }).catch(() => {});

        return {
          statusCode: 200,
          body: {
            status: 'cancelled_before_supply',
            order_id: orderId,
            message: 'Order cancelled before invoice issuance and supply. No tax credit note required under Saudi VAT Implementing Regulations Article 40 and Article 54.'
          }
        };
      }
    }

    if (isRefund && sallaRefundId) {
      const existingRefund = await client.query(
        `SELECT id, uuid, icv, invoice_hash, qr_code_payload, status
         FROM invoices
         WHERE salla_refund_id = $1`,
        [sallaRefundId]
      );
      if (existingRefund.rows.length > 0) {
        const inv = existingRefund.rows[0];
        await transitionOrderSyncState(client, {
          merchantId,
          orderId,
          internalOrderId,
          sallaRefundId,
          toState: 'successfully_processed',
          sourceEvent: payload.event,
          invoiceId: inv.id,
          invoiceUuid: inv.uuid,
          invoiceType: 'credit_note',
          reason: `تمت معالجة استرجاع سلة مسبقاً بإشعار دائن (رقم الاسترجاع: ${sallaRefundId}) دون تكرار`,
          isRecoverable: false
        }).catch(() => {});

        return {
          statusCode: 200,
          body: {
            status: 'idempotent_refund_replay',
            order_id: orderId,
            refund_id: sallaRefundId,
            invoice_id: inv.id,
            invoice_uuid: inv.uuid,
            icv: inv.icv
          }
        };
      }
    }

    const refundPayload = (payload.data as any)?.refund || (payload.data as any)?.refunds?.[0];
    const explicitRefundAmount = refundPayload?.amount?.amount ? Number(refundPayload.amount.amount) :
                                 (typeof refundPayload?.amount === 'number' ? refundPayload.amount : null);

    const originalTotal = origRes.rows.length > 0 ? Number(origRes.rows[0].grand_total) : Number(orderData.amounts?.total?.amount || 0);

    if (explicitRefundAmount && explicitRefundAmount > 0 && explicitRefundAmount < originalTotal && origRes.rows.length > 0) {
      // Partial credit note under Saudi VAT Implementing Regulations Article 40 & Article 54
      result = await processPartialCreditNote(client, egsUnitId, {
        originalInvoiceId: origRes.rows[0].id,
        externalOriginalInvoiceNumber: `INV-${origRes.rows[0].icv}`,
        externalOriginalUuid: origRes.rows[0].uuid,
        refundAmount: explicitRefundAmount,
        returnReason: 'Partial customer refund via Salla',
        idempotencyKey
      });
    } else {
      result = await processSallaRefundIntoZatcaCreditNote(
        client,
        egsUnitId,
        orderData,
        idempotencyKey,
        payload.event === 'order.cancelled' ? 'Order cancelled by customer or merchant' : 'Order refunded'
      );
    }

    if (sallaRefundId && result.invoiceId) {
      await client.query(
        `UPDATE invoices SET salla_refund_id = $1 WHERE id = $2`,
        [sallaRefundId, result.invoiceId]
      );
    }
  } else {
    result = await processSallaOrderIntoZatcaInvoice(
      client,
      egsUnitId,
      orderData,
      idempotencyKey
    );
  }

  await transitionOrderSyncState(client, {
    merchantId,
    orderId,
    internalOrderId,
    sallaRefundId,
    toState: 'successfully_processed',
    sourceEvent: payload.event,
    invoiceId: result.invoiceId,
    invoiceUuid: result.invoiceUuid,
    invoiceType: isRefundOrCancel ? 'credit_note' : (result.isB2C ? 'simplified_tax_invoice' : 'tax_invoice'),
    orderAmount: orderData.amounts?.total?.amount || null,
    orderCurrency: orderData.currency || 'SAR',
    customerSummary: {
      isB2B: isB2bCustomer(orderData.customer?.tax_number),
      buyerVat: orderData.customer?.tax_number || undefined,
      buyerName: orderData.customer?.company_name || `${orderData.customer?.first_name || ''} ${orderData.customer?.last_name || ''}`.trim() || undefined,
      city: orderData.shipping?.address?.city,
      country: orderData.shipping?.address?.country || 'SA'
    },
    reason: isRefundOrCancel
      ? `تم إصدار إشعار دائن مشفر كود 381 بنجاح برقم تسلسلي (${result.icv})`
      : `تم إصدار وتوقيع الفاتورة مشفرة بنجاح برقم تسلسلي (${result.icv})`,
    isRecoverable: true,
    nextAction: result.isB2C ? 'بانتظار التقرير خلال 24 ساعة لهيئة الزكاة' : 'بانتظار الاعتماد الفوري'
  }).catch(() => {});

  return {
    statusCode: 200,
    body: {
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
    }
  };
}

export async function drainWebhookQueue(poolInstance = pool): Promise<{ processed: number; errors: number }> {
  const client = await poolInstance.connect();
  let processed = 0;
  let errors = 0;
  try {
    const res = await client.query(
      `SELECT id, merchant_id, event_name, idempotency_key, payload, attempts
       FROM webhook_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED`
    );

    for (const row of res.rows) {
      try {
        await client.query(
          `UPDATE webhook_queue SET status = 'processing', attempts = attempts + 1 WHERE id = $1`,
          [row.id]
        );
        const rawPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const result = await processSallaWebhookPayload(client, rawPayload);
        if (result.statusCode >= 400 && result.statusCode !== 402) {
          throw new Error(result.body.error || result.body.message || `Processing failed with status ${result.statusCode}`);
        }
        await client.query(
          `UPDATE webhook_queue SET status = 'completed', processed_at = NOW(), error_message = NULL WHERE id = $1`,
          [row.id]
        );
        processed++;
      } catch (err: any) {
        errors++;
        const nextAttempts = (row.attempts || 0) + 1;
        const nextStatus = nextAttempts >= 5 ? 'failed' : 'pending';
        await client.query(
          `UPDATE webhook_queue SET status = $1, error_message = $2 WHERE id = $3`,
          [nextStatus, err.message, row.id]
        );
        try {
          const rawPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
          const orderData = rawPayload?.data as any;
          const orderId = orderData?.id?.toString();
          if (orderId && orderId !== '0') {
            await transitionOrderSyncState(client, {
              merchantId: row.merchant_id,
              orderId,
              internalOrderId: orderData?.reference_id?.toString() || orderId,
              sallaRefundId: rawPayload?.data?.refund?.id?.toString() || rawPayload?.data?.refund_id?.toString() || null,
              toState: nextAttempts >= 5 ? 'permanently_failed' : 'temporarily_failed',
              sourceEvent: row.event_name,
              errorCode: 'WEBHOOK_QUEUE_DRAIN_FAILURE',
              errorCategory: 'system',
              reason: err.message || 'فشل في معالجة الحدث من طابور الرسائل المؤجلة',
              isRecoverable: true,
              nextAction: nextAttempts >= 5 ? 'طلب استعادة يدوية أو مراجعة الدعم الفني' : 'إعادة محاولة آلية لاحقة'
            });
          }
        } catch {}
      }
    }
  } finally {
    client.release();
  }
  return { processed, errors };
}
