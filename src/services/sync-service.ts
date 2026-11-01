import { PoolClient, Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { recordAuditLog } from '../storage/db.js';
import { submitInvoiceToFatoora, FatooraDispatchResult } from './fatoora-dispatcher.js';
import {
  processSallaOrderIntoZatcaInvoice,
  processSallaRefundIntoZatcaCreditNote,
  isB2bCustomer,
  validateB2bBuyerAddress
} from './invoice-generator.js';
import { SallaOrderData } from '../types/salla.js';
import { resolveEgsUnitForOrder } from './branch-router.js';

export type SyncState =
  | 'not_received'
  | 'received'
  | 'persisted'
  | 'awaiting_processing'
  | 'processing'
  | 'successfully_processed'
  | 'zatca_submission_pending'
  | 'successfully_reported'
  | 'successfully_cleared'
  | 'temporarily_failed'
  | 'permanently_failed'
  | 'not_eligible'
  | 'requires_human_review';

export interface OrderSyncRecord {
  id: string;
  merchantId: string;
  orderId: string;
  syncState: SyncState;
  sourceEvent?: string;
  invoiceId?: string | null;
  invoiceUuid?: string | null;
  invoiceType?: string | null;
  attemptCount: number;
  correlationId?: string;
  errorCode?: string | null;
  errorCategory?: string | null;
  reason?: string | null;
  isRecoverable: boolean;
  orderAmount?: number | null;
  orderCurrency?: string;
  customerSummary?: {
    isB2B: boolean;
    buyerVat?: string;
    buyerName?: string;
    city?: string;
    country?: string;
  } | null;
  eligibilityDetails?: Record<string, any> | null;
  lastEventAt: Date;
  nextAction?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderSyncTransition {
  id: string;
  syncRecordId: string;
  merchantId: string;
  orderId: string;
  fromState: SyncState | null;
  toState: SyncState;
  sourceEvent?: string;
  invoiceId?: string | null;
  invoiceUuid?: string | null;
  correlationId?: string;
  attemptNumber: number;
  reason?: string | null;
  errorCode?: string | null;
  errorCategory?: string | null;
  metadata?: Record<string, any> | null;
  createdAt: Date;
}

export interface OrderSyncWithTransitions extends OrderSyncRecord {
  transitions: OrderSyncTransition[];
}

export interface SyncTransitionInput {
  merchantId: string;
  orderId: string;
  toState: SyncState;
  sourceEvent?: string;
  invoiceId?: string | null;
  invoiceUuid?: string | null;
  invoiceType?: string | null;
  correlationId?: string;
  errorCode?: string | null;
  errorCategory?: string | null;
  reason?: string | null;
  isRecoverable?: boolean;
  orderAmount?: number | null;
  orderCurrency?: string;
  customerSummary?: {
    isB2B: boolean;
    buyerVat?: string;
    buyerName?: string;
    city?: string;
    country?: string;
  } | null;
  eligibilityDetails?: Record<string, any> | null;
  nextAction?: string | null;
  metadata?: Record<string, any> | null;
}

export interface SyncQueryOptions {
  search?: string;
  syncState?: SyncState | 'failed' | 'all';
  fromDate?: string;
  toDate?: string;
  documentType?: 'tax_invoice' | 'simplified_tax_invoice' | 'credit_note';
  onlyRequiresAction?: boolean;
  limit?: number;
  offset?: number;
}

export interface MerchantSyncConfig {
  merchantId: string;
  storeName?: string;
  vatNumber?: string;
  codFulfillmentStatuses?: string[];
  activeSubscription?: boolean;
  installedAt?: Date;
  hasActiveEgs?: boolean;
}

export interface SyncRulesExplanation {
  consumedEvents: Array<{
    event: string;
    nameArabic: string;
    nameEnglish: string;
    purpose: string;
  }>;
  orderStateTriggers: Array<{
    paymentType: string;
    triggerCondition: string;
    explanationArabic: string;
    explanationEnglish: string;
  }>;
  ineligibilityRules: Array<{
    condition: string;
    behavior: string;
    explanationArabic: string;
    explanationEnglish: string;
  }>;
  statusChangeRules: {
    explanationArabic: string;
    explanationEnglish: string;
  };
  cancellationRules: {
    preSupply: string;
    postInvoice: string;
    explanationArabic: string;
    explanationEnglish: string;
  };
  refundRules: {
    explanationArabic: string;
    explanationEnglish: string;
  };
  existingInvoiceImpact: {
    explanationArabic: string;
    explanationEnglish: string;
  };
  historicalOrdersBoundary: {
    boundaryDate: string | null;
    policyArabic: string;
    policyEnglish: string;
  };
  onboardingExpectations: {
    explanationArabic: string;
    explanationEnglish: string;
  };
}

export interface SyncPreviewResult {
  merchantId: string;
  sampleTotal: number;
  historicalBoundary: string;
  summary: {
    eligible: number;
    notEligible: number;
    requiresHumanReview: number;
  };
  sampleOrders: Array<{
    orderId: string;
    orderDate: string;
    paymentMethod: string;
    status: string;
    classification: 'eligible' | 'not_eligible' | 'requires_human_review';
    reason: string;
    expectedDocumentType: string;
  }>;
}

export interface RecoveryResult {
  orderId: string;
  success: boolean;
  actionTaken: 'resumed_submission' | 'invoiced_and_submitted' | 'already_settled' | 'deferred_held' | 'rejected_ineligible';
  syncState: SyncState;
  invoiceId?: string | null;
  invoiceUuid?: string | null;
  icv?: number | null;
  messageArabic: string;
  messageEnglish: string;
  details?: Record<string, any>;
}

export interface OrderSupportDiagnostics {
  generatedAt: string;
  orderId: string;
  merchantId: string;
  currentSyncState: SyncState;
  isRecoverable: boolean;
  correlationId?: string;
  summary: {
    attempts: number;
    firstSeenAt: string;
    lastEventAt: string;
    invoiceId?: string | null;
    invoiceUuid?: string | null;
    invoiceType?: string | null;
    amount?: number | null;
    currency?: string;
    customerType: 'B2B' | 'B2C';
  };
  eligibility: Record<string, any>;
  timeline: Array<{
    step: number;
    state: SyncState;
    event?: string;
    timestamp: string;
    reason?: string | null;
    errorCategory?: string | null;
    errorCode?: string | null;
  }>;
  zatcaSubmissionDetails?: {
    httpStatus?: number;
    isOutage: boolean;
    submissionTimestamp?: string;
    parsedWarnings?: any[];
    parsedErrors?: any[];
  } | null;
  recoveryEligibility: {
    canRecoverNow: boolean;
    blockers: string[];
  };
}

export async function transitionOrderSyncState(
  client: PoolClient | Pool,
  input: SyncTransitionInput
): Promise<OrderSyncRecord> {
  const correlationId = input.correlationId || `corr_${input.orderId}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  
  // Compute default nextAction and isRecoverable based on state
  let isRecoverable = input.isRecoverable !== undefined ? input.isRecoverable : false;
  let nextAction = input.nextAction;

  if (!nextAction) {
    switch (input.toState) {
      case 'not_received':
        nextAction = 'بانتظار وصول حدث الطلب من سلة أو تشغيل المطابقة / Awaiting webhook delivery or reconciliation';
        break;
      case 'received':
      case 'persisted':
        nextAction = 'جاري التحقق من أحقية الطلب وحساب الضرائب / Validating order eligibility';
        break;
      case 'awaiting_processing':
        nextAction = 'بانتظار اكتمال تسليم الطلب (دفع عند الاستلام أو تحويل) / Awaiting delivery completion for COD/transfer';
        break;
      case 'processing':
        nextAction = 'جاري توقيع المستند وتجهيز حزم ZATCA / Signing tax document';
        break;
      case 'successfully_processed':
        nextAction = 'المستند موقع بنجاح بانتظار الإرسال لمنصة فاتورة / Document signed, awaiting dispatch';
        break;
      case 'zatca_submission_pending':
        nextAction = 'جاري إرسال الفاتورة لهيئة الزكاة / Transmitting to ZATCA gateway';
        break;
      case 'successfully_reported':
      case 'successfully_cleared':
        nextAction = 'مكتمل بنجاح وموثق في هيئة الزكاة / Completed and verified by ZATCA';
        isRecoverable = false;
        break;
      case 'temporarily_failed':
        nextAction = 'إعادة المحاولة مجدولة تلقائياً مع طابور التعافي / Auto-retry scheduled via recovery queue';
        isRecoverable = true;
        break;
      case 'permanently_failed':
        nextAction = 'فشل دائم بسبب خطأ في البيانات يتطلب تصحيح البيانات / Permanent failure; requires data correction';
        isRecoverable = false;
        break;
      case 'not_eligible':
        nextAction = 'طلب غير خاضع لإصدار فاتورة ضريبية / Order not eligible for tax invoice';
        isRecoverable = false;
        break;
      case 'requires_human_review':
        nextAction = 'يتطلب استكمال العنوان الوطني للشركات أو مراجعة التاجر / Requires corporate national address completion';
        isRecoverable = true;
        break;
    }
  }

  // 1. Fetch current sync record if exists
  const existingRes = await client.query(
    `SELECT id, sync_state, attempt_count, invoice_id, invoice_uuid, invoice_type
     FROM order_sync_records
     WHERE merchant_id = $1 AND order_id = $2`,
    [input.merchantId, input.orderId]
  );

  let syncRecordId: string;
  let fromState: SyncState | null = null;
  let currentAttempts = 1;

  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    syncRecordId = existing.id;
    fromState = existing.sync_state as SyncState;
    currentAttempts = Number(existing.attempt_count) + 1;

    const invoiceIdToSave = input.invoiceId !== undefined ? input.invoiceId : existing.invoice_id;
    const invoiceUuidToSave = input.invoiceUuid !== undefined ? input.invoiceUuid : existing.invoice_uuid;
    const invoiceTypeToSave = input.invoiceType !== undefined ? input.invoiceType : existing.invoice_type;

    await client.query(
      `UPDATE order_sync_records
       SET sync_state = $1,
           source_event = COALESCE($2, source_event),
           invoice_id = $3,
           invoice_uuid = $4,
           invoice_type = COALESCE($5, invoice_type),
           attempt_count = $6,
           correlation_id = $7,
           error_code = $8,
           error_category = $9,
           reason = $10,
           is_recoverable = $11,
           order_amount = COALESCE($12, order_amount),
           order_currency = COALESCE($13, order_currency),
           customer_summary = COALESCE($14::jsonb, customer_summary),
           eligibility_details = COALESCE($15::jsonb, eligibility_details),
           next_action = $16,
           last_event_at = NOW(),
           updated_at = NOW()
       WHERE id = $17`,
      [
        input.toState,
        input.sourceEvent || null,
        invoiceIdToSave,
        invoiceUuidToSave,
        invoiceTypeToSave || null,
        currentAttempts,
        correlationId,
        input.errorCode || null,
        input.errorCategory || null,
        input.reason || null,
        isRecoverable,
        input.orderAmount !== undefined ? input.orderAmount : null,
        input.orderCurrency || 'SAR',
        input.customerSummary ? JSON.stringify(input.customerSummary) : null,
        input.eligibilityDetails ? JSON.stringify(input.eligibilityDetails) : null,
        nextAction,
        syncRecordId
      ]
    );
  } else {
    const insertRes = await client.query(
      `INSERT INTO order_sync_records (
        merchant_id, order_id, sync_state, source_event,
        invoice_id, invoice_uuid, invoice_type, attempt_count,
        correlation_id, error_code, error_category, reason,
        is_recoverable, order_amount, order_currency, customer_summary,
        eligibility_details, next_action, last_event_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17, NOW(), NOW(), NOW())
      RETURNING id`,
      [
        input.merchantId,
        input.orderId,
        input.toState,
        input.sourceEvent || null,
        input.invoiceId || null,
        input.invoiceUuid || null,
        input.invoiceType || null,
        correlationId,
        input.errorCode || null,
        input.errorCategory || null,
        input.reason || null,
        isRecoverable,
        input.orderAmount !== undefined ? input.orderAmount : null,
        input.orderCurrency || 'SAR',
        input.customerSummary ? JSON.stringify(input.customerSummary) : null,
        input.eligibilityDetails ? JSON.stringify(input.eligibilityDetails) : null,
        nextAction
      ]
    );
    syncRecordId = insertRes.rows[0].id;
  }

  // 2. Append to transition log
  await client.query(
    `INSERT INTO order_sync_transitions (
      sync_record_id, merchant_id, order_id, from_state, to_state,
      source_event, invoice_id, invoice_uuid, correlation_id,
      attempt_number, reason, error_code, error_category, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW())`,
    [
      syncRecordId,
      input.merchantId,
      input.orderId,
      fromState,
      input.toState,
      input.sourceEvent || null,
      input.invoiceId || null,
      input.invoiceUuid || null,
      correlationId,
      currentAttempts,
      input.reason || null,
      input.errorCode || null,
      input.errorCategory || null,
      input.metadata ? JSON.stringify(input.metadata) : null
    ]
  );

  return {
    id: syncRecordId,
    merchantId: input.merchantId,
    orderId: input.orderId,
    syncState: input.toState,
    sourceEvent: input.sourceEvent,
    invoiceId: input.invoiceId,
    invoiceUuid: input.invoiceUuid,
    invoiceType: input.invoiceType,
    attemptCount: currentAttempts,
    correlationId,
    errorCode: input.errorCode,
    errorCategory: input.errorCategory,
    reason: input.reason,
    isRecoverable,
    orderAmount: input.orderAmount,
    orderCurrency: input.orderCurrency || 'SAR',
    customerSummary: input.customerSummary,
    eligibilityDetails: input.eligibilityDetails,
    lastEventAt: new Date(),
    nextAction,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

export async function getOrderSyncWithHistory(
  client: PoolClient | Pool,
  merchantId: string,
  orderId: string
): Promise<OrderSyncWithTransitions | null> {
  const recordRes = await client.query(
    `SELECT * FROM order_sync_records
     WHERE merchant_id = $1 AND order_id = $2`,
    [merchantId, orderId]
  );

  if (recordRes.rows.length === 0) {
    return null;
  }

  const row = recordRes.rows[0];
  const transitionsRes = await client.query(
    `SELECT * FROM order_sync_transitions
     WHERE sync_record_id = $1
     ORDER BY created_at ASC`,
    [row.id]
  );

  return {
    id: row.id,
    merchantId: row.merchant_id,
    orderId: row.order_id,
    syncState: row.sync_state,
    sourceEvent: row.source_event,
    invoiceId: row.invoice_id,
    invoiceUuid: row.invoice_uuid,
    invoiceType: row.invoice_type,
    attemptCount: Number(row.attempt_count),
    correlationId: row.correlation_id,
    errorCode: row.error_code,
    errorCategory: row.error_category,
    reason: row.reason,
    isRecoverable: Boolean(row.is_recoverable),
    orderAmount: row.order_amount ? Number(row.order_amount) : null,
    orderCurrency: row.order_currency || 'SAR',
    customerSummary: typeof row.customer_summary === 'string' ? JSON.parse(row.customer_summary) : row.customer_summary,
    eligibilityDetails: typeof row.eligibility_details === 'string' ? JSON.parse(row.eligibility_details) : row.eligibility_details,
    lastEventAt: new Date(row.last_event_at),
    nextAction: row.next_action,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    transitions: transitionsRes.rows.map((t: any) => ({
      id: t.id,
      syncRecordId: t.sync_record_id,
      merchantId: t.merchant_id,
      orderId: t.order_id,
      fromState: t.from_state,
      toState: t.to_state,
      sourceEvent: t.source_event,
      invoiceId: t.invoice_id,
      invoiceUuid: t.invoice_uuid,
      correlationId: t.correlation_id,
      attemptNumber: Number(t.attempt_number),
      reason: t.reason,
      errorCode: t.error_code,
      errorCategory: t.error_category,
      metadata: typeof t.metadata === 'string' ? JSON.parse(t.metadata) : t.metadata,
      createdAt: new Date(t.created_at)
    }))
  };
}

export async function queryOrderSyncRecords(
  client: PoolClient | Pool,
  merchantId: string,
  options: SyncQueryOptions = {}
): Promise<{ records: OrderSyncRecord[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(options.limit || 20, 1), 100);
  const offset = Math.max(options.offset || 0, 0);

  const whereClauses: string[] = ['merchant_id = $1'];
  const params: any[] = [merchantId];

  if (options.search) {
    params.push(`%${options.search.trim()}%`);
    const searchIdx = params.length;
    whereClauses.push(`(order_id ILIKE $${searchIdx} OR id::text ILIKE $${searchIdx} OR invoice_uuid::text ILIKE $${searchIdx})`);
  }

  if (options.syncState && options.syncState !== 'all') {
    if (options.syncState === 'failed') {
      whereClauses.push(`sync_state IN ('temporarily_failed', 'permanently_failed')`);
    } else {
      params.push(options.syncState);
      whereClauses.push(`sync_state = $${params.length}`);
    }
  }

  if (options.onlyRequiresAction) {
    whereClauses.push(`sync_state IN ('temporarily_failed', 'requires_human_review', 'awaiting_processing')`);
  }

  if (options.documentType) {
    params.push(options.documentType);
    whereClauses.push(`invoice_type = $${params.length}`);
  }

  if (options.fromDate) {
    params.push(options.fromDate);
    whereClauses.push(`created_at >= $${params.length}::timestamptz`);
  }

  if (options.toDate) {
    params.push(options.toDate);
    whereClauses.push(`created_at <= $${params.length}::timestamptz`);
  }

  const whereStr = whereClauses.join(' AND ');

  const countRes = await client.query(
    `SELECT COUNT(*) AS total FROM order_sync_records WHERE ${whereStr}`,
    params
  );
  const total = Number(countRes.rows[0].total);

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const recordsRes = await client.query(
    `SELECT * FROM order_sync_records
     WHERE ${whereStr}
     ORDER BY updated_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return {
    records: recordsRes.rows.map((row: any) => ({
      id: row.id,
      merchantId: row.merchant_id,
      orderId: row.order_id,
      syncState: row.sync_state,
      sourceEvent: row.source_event,
      invoiceId: row.invoice_id,
      invoiceUuid: row.invoice_uuid,
      invoiceType: row.invoice_type,
      attemptCount: Number(row.attempt_count),
      correlationId: row.correlation_id,
      errorCode: row.error_code,
      errorCategory: row.error_category,
      reason: row.reason,
      isRecoverable: Boolean(row.is_recoverable),
      orderAmount: row.order_amount ? Number(row.order_amount) : null,
      orderCurrency: row.order_currency || 'SAR',
      customerSummary: typeof row.customer_summary === 'string' ? JSON.parse(row.customer_summary) : row.customer_summary,
      eligibilityDetails: typeof row.eligibility_details === 'string' ? JSON.parse(row.eligibility_details) : row.eligibility_details,
      lastEventAt: new Date(row.last_event_at),
      nextAction: row.next_action,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    })),
    total,
    limit,
    offset
  };
}

export function getSyncRulesExplanation(config: MerchantSyncConfig): SyncRulesExplanation {
  const allowedCodSlugs = config.codFulfillmentStatuses || ['completed', 'delivered'];
  const boundaryIso = config.installedAt ? config.installedAt.toISOString().split('T')[0] : 'تاريخ تثبيت التطبيق / Installation Date';

  return {
    consumedEvents: [
      {
        event: 'order.created',
        nameArabic: 'إنشاء طلب جديد',
        nameEnglish: 'Order Created',
        purpose: 'التقاط الطلبات المدفوعة مسبقاً وتجهيز الفواتير فور السداد / Captures prepaid orders for immediate invoice creation'
      },
      {
        event: 'order.updated',
        nameArabic: 'تحديث حالة الطلب',
        nameEnglish: 'Order Updated',
        purpose: 'مراقبة تحول طلبات الدفع عند الاستلام والحوالات لحالة التسليم، أو استكمال العنوان الوطني / Detects fulfillment of COD orders or B2B address updates'
      },
      {
        event: 'order.refunded',
        nameArabic: 'استرجاع الطلب',
        nameEnglish: 'Order Refunded',
        purpose: 'إصدار إشعار دائن رسمي (Credit Note 381) يرتبط برقم الفاتورة الأصلية / Generates compliant Credit Note 381 linked to original invoice'
      },
      {
        event: 'order.cancelled',
        nameArabic: 'إلغاء الطلب',
        nameEnglish: 'Order Cancelled',
        purpose: 'إلغاء تشغيلي بدون أثر ضريبي إن كان قبل التوريد، أو إشعار دائن إن كانت الفاتورة قد صدرت / Operational cancel if pre-supply, or credit note if previously invoiced'
      }
    ],
    orderStateTriggers: [
      {
        paymentType: 'المدفوعات الإلكترونية (مدى، فيزا، ماستركارد، Apple Pay، تابي، تمارا)',
        triggerCondition: 'فوري عند استلام حدث إنشاء الطلب / Immediate upon order creation',
        explanationArabic: 'تعتبر واقعة التوريد منشئة للضريبة فوراً بسبب تحصيل المقابل المالي، فيتم إصدار الفاتورة وتوقيعها مشفراً دون تأخير.',
        explanationEnglish: 'Tax point occurs upon receipt of consideration. Invoices are signed and recorded immediately.'
      },
      {
        paymentType: 'الدفع عند الاستلام والحوالات البنكية (COD & Bank Transfer)',
        triggerCondition: `مؤجل حتى اكتمال التسليم (${allowedCodSlugs.join(' أو ')})`,
        explanationArabic: `لحماية تسلسل الـ ICV ومنع حرق الأرقام التسلسلية لطلبات قد يتم رفض استلامها، يؤجل إصدار الفاتورة حتى يصل الطلب لإحدى الحالات المعتمدة: ${allowedCodSlugs.join('، ')}.`,
        explanationEnglish: `Defers invoice creation until goods are delivered (${allowedCodSlugs.join(', ')}) to prevent uncollectible tax recognition.`
      }
    ],
    ineligibilityRules: [
      {
        condition: 'طلبات الشركات B2B غير مكتملة العنوان الوطني',
        behavior: 'حجز مؤقت في طابور التدقيق البشري (Requires Human Review)',
        explanationArabic: 'تشترط هيئة الزكاة رقم مبنى من 4 أرقام ورمز بريدي لفواتير الشركات. يتم حجز الطلب دون إصدار فاتورة منعاً لرفضها، وتنبيه التاجر لاستكماله.',
        explanationEnglish: 'B2B invoices without national address 4-digit building number are placed on hold to protect clearance.'
      },
      {
        condition: 'الطلبات الملغاة قبل التوريد ودون إصدار فاتورة مسبقة',
        behavior: 'عدم أهلية ضريبية (Not Eligible)',
        explanationArabic: 'إلغاء تشغيلي بحت. بما أنه لم تقع واقعة توريد ولم تصدر فاتورة، فلا يجوز نظاماً إصدار إشعار دائن لعدم وجود وعاء ضريبي.',
        explanationEnglish: 'No taxable supply occurred and no invoice was issued. Legally prohibited from generating redundant credit note.'
      }
    ],
    statusChangeRules: {
      explanationArabic: 'تغيير حالة الطلب في سلة لا يعيد إصدار الفاتورة إذا كانت قد صدرت مسبقاً، حماية لعدم التكرار وتطابق الهاش التراكمي.',
      explanationEnglish: 'Subsequent order status transitions never duplicate already-issued invoices or alter sequential hash chains.'
    },
    cancellationRules: {
      preSupply: 'إلغاء تشغيلي بدون أثر ضريبي لعدم وجود فاتورة مصدرة / Operational cancellation without tax document',
      postInvoice: 'إصدار إشعار دائن معتمد (كود 381) يرتبط برقم الفاتورة الأصلية / Generates Credit Note 381 referencing original invoice',
      explanationArabic: 'يميز النظام بدقة بين إلغاء طلب لم يفوتر (لا يتطلب أي مستند ضريبي) وبين طلب مفوتر تم إلغاؤه (يتطلب إشعار دائن 381 لتسوية الضريبة).',
      explanationEnglish: 'Distinguishes between un-invoiced cancellations (zero tax effect) and invoiced cancellations (mandates Credit Note 381).'
    },
    refundRules: {
      explanationArabic: 'كل عملية استرجاع ترتبط بالفاتورة الأصلية ورقمها التسلسلي، مع توليد إشعار دائن مشفر بهيئة UBL 2.1 ورمز QR معتمد.',
      explanationEnglish: 'Every refund links to the original invoice, issuing a compliant Credit Note 381 with cryptographic reference and TLV QR.'
    },
    existingInvoiceImpact: {
      explanationArabic: 'عند تكرار وصول الأحداث لنفس الطلب، يتحقق النظام من قاعدة البيانات ويرد بنسخة الفاتورة الحالية (Idempotent Replay) دون زيادة الـ ICV.',
      explanationEnglish: 'Duplicate event deliveries are safely deduplicated at the database boundary, returning existing invoices without incrementing ICV.'
    },
    historicalOrdersBoundary: {
      boundaryDate: boundaryIso,
      policyArabic: `تبدأ المزامنة التلقائية حصراً للطلبات المنشأة بعد تاريخ التثبيت (${boundaryIso}). الطلبات التاريخية السابقة لا تفوتر تلقائياً منعاً لتعارض الإقرارات الضريبية السابقة.`,
      policyEnglish: `Automatic processing strictly covers orders created after installation (${boundaryIso}). Historical orders are not auto-invoiced.`
    },
    onboardingExpectations: {
      explanationArabic: 'بعد تفعيل الربط، ستشاهد كل طلب في جدول المزامنة مع شرح لسبب كل خطوة. الفواتير المبسطة ترفع خلال 24 ساعة، وفواتير الشركات ترسل للاعتماد الفوري.',
      explanationEnglish: 'Once enabled, all orders appear in the synchronization view with transparent status. B2C reports within 24h, B2B clears in real time.'
    }
  };
}

export async function generateSyncPreview(
  client: PoolClient | Pool,
  merchantId: string
): Promise<SyncPreviewResult> {
  const boundaryDate = new Date();
  boundaryDate.setDate(boundaryDate.getDate() - 30);
  const boundaryIso = boundaryDate.toISOString().split('T')[0];

  // Inspect existing records in database or generate a representative realistic preview
  const syncRecordsRes = await client.query(
    `SELECT order_id, created_at, sync_state, order_amount, order_currency, customer_summary
     FROM order_sync_records
     WHERE merchant_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [merchantId]
  );

  let sampleOrders: Array<{
    orderId: string;
    orderDate: string;
    paymentMethod: string;
    status: string;
    classification: 'eligible' | 'not_eligible' | 'requires_human_review';
    reason: string;
    expectedDocumentType: string;
  }> = [];

  let eligible = 0;
  let notEligible = 0;
  let requiresHumanReview = 0;

  if (syncRecordsRes.rows.length > 0) {
    for (const row of syncRecordsRes.rows) {
      const isReview = row.sync_state === 'requires_human_review';
      const isNot = row.sync_state === 'not_eligible';
      const isElig = !isReview && !isNot;

      if (isReview) requiresHumanReview++;
      else if (isNot) notEligible++;
      else eligible++;

      sampleOrders.push({
        orderId: row.order_id,
        orderDate: new Date(row.created_at).toISOString().split('T')[0],
        paymentMethod: 'Credit Card / Mada',
        status: isElig ? 'Delivered' : (isReview ? 'Awaiting Address' : 'Draft'),
        classification: isReview ? 'requires_human_review' : (isNot ? 'not_eligible' : 'eligible'),
        reason: isReview ? 'نقص العنوان الوطني لمشتري الشركات' : (isNot ? 'طلب غير خاضع للضريبة' : 'طلب مكتمل مؤهل لإصدار فاتورة ضريبية'),
        expectedDocumentType: 'simplified_tax_invoice'
      });
    }
  } else {
    // Representative realistic preview based on actual rules
    sampleOrders = [
      {
        orderId: 'SALLA-ORD-101',
        orderDate: new Date().toISOString().split('T')[0],
        paymentMethod: 'mada',
        status: 'paid',
        classification: 'eligible',
        reason: 'طلب إلكتروني مسدد مؤهل للإصدار الفوري / Prepaid completed order',
        expectedDocumentType: 'فاتورة ضريبية مبسطة (Simplified B2C)'
      },
      {
        orderId: 'SALLA-ORD-102',
        orderDate: new Date().toISOString().split('T')[0],
        paymentMethod: 'credit_card',
        status: 'paid',
        classification: 'requires_human_review',
        reason: 'طلب شركة برقم ضريبي مع نقص في بيانات العنوان الوطني المعتمد / Corporate buyer missing national address',
        expectedDocumentType: 'فاتورة ضريبية قياسية (Standard B2B - عند الاستكمال)'
      },
      {
        orderId: 'SALLA-ORD-103',
        orderDate: new Date().toISOString().split('T')[0],
        paymentMethod: 'cod',
        status: 'in_review',
        classification: 'not_eligible',
        reason: 'دفع عند الاستلام بانتظار اكتمال التسليم قبل الفوترة / COD order held until delivery',
        expectedDocumentType: 'مؤجل حتى التسليم (Deferred)'
      },
      {
        orderId: 'SALLA-ORD-104',
        orderDate: boundaryIso,
        paymentMethod: 'apple_pay',
        status: 'cancelled',
        classification: 'not_eligible',
        reason: 'طلب ملغي قبل التوريد ولم تصدر له فاتورة / Pre-supply operational cancellation',
        expectedDocumentType: 'لا يتطلب مستند (None)'
      }
    ];
    eligible = 1;
    requiresHumanReview = 1;
    notEligible = 2;
  }

  return {
    merchantId,
    sampleTotal: sampleOrders.length,
    historicalBoundary: boundaryIso,
    summary: {
      eligible,
      notEligible,
      requiresHumanReview
    },
    sampleOrders
  };
}

export async function executeSafeOrderRecovery(
  client: PoolClient,
  merchantId: string,
  orderId: string,
  actor: string = 'merchant_portal'
): Promise<RecoveryResult> {
  // SAFEGUARD 1: Atomic transaction & advisory lock to reject simultaneous recovery attempts on the same order
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('sync_recover_' || $1 || '_' || $2))`,
    [merchantId, orderId]
  );

  // SAFEGUARD 2: Load current local tax document state
  const existingInvoiceRes = await client.query(
    `SELECT i.id, i.uuid, i.icv, i.status, i.invoice_type, i.invoice_hash,
            i.qr_code_payload, i.signed_xml, i.egs_unit_id
     FROM invoices i
     JOIN egs_units u ON i.egs_unit_id = u.id
     WHERE u.merchant_id = $1 AND i.order_id = $2
     ORDER BY i.created_at DESC LIMIT 1`,
    [merchantId, orderId]
  );

  // SAFEGUARD 3: If invoice already exists and is cleared or reported, do not regenerate or allocate new ICV
  if (existingInvoiceRes.rows.length > 0) {
    const existing = existingInvoiceRes.rows[0];
    const status = existing.status;

    if (status === 'cleared' || status === 'cleared_with_warnings' || status === 'reported' || status === 'reported_with_warnings') {
      await transitionOrderSyncState(client, {
        merchantId,
        orderId,
        toState: status.startsWith('cleared') ? 'successfully_cleared' : 'successfully_reported',
        sourceEvent: 'manual_recovery',
        invoiceId: existing.id,
        invoiceUuid: existing.uuid,
        invoiceType: existing.invoice_type,
        reason: 'المستند الضريبي معتمد مسبقاً لدى هيئة الزكاة / Document already settled with ZATCA',
        isRecoverable: false,
        nextAction: 'مكتمل بنجاح وموثق لدى هيئة الزكاة / Completed and verified'
      });

      return {
        orderId,
        success: true,
        actionTaken: 'already_settled',
        syncState: status.startsWith('cleared') ? 'successfully_cleared' : 'successfully_reported',
        invoiceId: existing.id,
        invoiceUuid: existing.uuid,
        icv: Number(existing.icv),
        messageArabic: 'الطلب مفوتر مسبقاً ومعتمد رسمياً لدى هيئة الزكاة. تم تحديث سجل المزامنة دون إصدار مستند مكرر.',
        messageEnglish: 'Order already has a compliant, settled invoice with ZATCA. State updated without duplicate issuance.'
      };
    }

    // SAFEGUARD 4: If invoice exists in draft/submitted or DLQ, resume only permitted existing workflow (dispatch)
    // Never allocate another ICV or regenerate XML
    try {
      await transitionOrderSyncState(client, {
        merchantId,
        orderId,
        toState: 'zatca_submission_pending',
        sourceEvent: 'manual_recovery',
        invoiceId: existing.id,
        invoiceUuid: existing.uuid,
        invoiceType: existing.invoice_type,
        reason: 'إعادة إرسال الفاتورة الحالية إلى هيئة الزكاة دون إعادة التوليد / Resuming submission of existing signed invoice'
      });

      const dispatchResult: FatooraDispatchResult = await submitInvoiceToFatoora(client, existing.id);

      if (dispatchResult.status === 'cleared' || dispatchResult.status === 'reported') {
        const finalState = dispatchResult.status === 'cleared' ? 'successfully_cleared' : 'successfully_reported';
        await transitionOrderSyncState(client, {
          merchantId,
          orderId,
          toState: finalState,
          sourceEvent: 'manual_recovery',
          invoiceId: existing.id,
          invoiceUuid: existing.uuid,
          invoiceType: existing.invoice_type,
          reason: 'تم اعتماد المستند بنجاح من هيئة الزكاة بعد إعادة المحاولة / Successfully accepted by ZATCA after retry',
          isRecoverable: false
        });

        // Resolve DLQ entry if existed
        await client.query(
          `UPDATE zatca_dlq SET resolved_at = NOW() WHERE invoice_id = $1`,
          [existing.id]
        );

        await recordAuditLog(client, {
          entityType: 'order_sync',
          entityId: orderId,
          action: 'recovery_dispatch_success',
          actor,
          payload: { invoiceId: existing.id, invoiceUuid: existing.uuid, status: dispatchResult.status }
        });

        return {
          orderId,
          success: true,
          actionTaken: 'resumed_submission',
          syncState: finalState,
          invoiceId: existing.id,
          invoiceUuid: existing.uuid,
          icv: Number(existing.icv),
          messageArabic: `تم إعادة إرسال الفاتورة رقم (${existing.icv}) واعتمادها رسمياً من هيئة الزكاة.`,
          messageEnglish: `Existing invoice (ICV ${existing.icv}) successfully re-submitted and accepted by ZATCA.`
        };
      } else {
        await transitionOrderSyncState(client, {
          merchantId,
          orderId,
          toState: 'temporarily_failed',
          sourceEvent: 'manual_recovery',
          invoiceId: existing.id,
          invoiceUuid: existing.uuid,
          invoiceType: existing.invoice_type,
          reason: dispatchResult.message || 'بوابة الزكاة أعادت استجابة غير معتمدة / Gateway returned retryable status',
          isRecoverable: true
        });

        return {
          orderId,
          success: false,
          actionTaken: 'resumed_submission',
          syncState: 'temporarily_failed',
          invoiceId: existing.id,
          invoiceUuid: existing.uuid,
          icv: Number(existing.icv),
          messageArabic: 'فشلت محاولة الاتصال بهيئة الزكاة مجدداً. تم إدراج الفاتورة في طابور المحاولة الآلي.',
          messageEnglish: 'ZATCA gateway rejected or timed out. Order scheduled for automatic background retry.'
        };
      }
    } catch (err: any) {
      await transitionOrderSyncState(client, {
        merchantId,
        orderId,
        toState: 'temporarily_failed',
        sourceEvent: 'manual_recovery',
        invoiceId: existing.id,
        invoiceUuid: existing.uuid,
        reason: `خطأ أثناء الاتصال بهيئة الزكاة: ${err.message}`
      });

      return {
        orderId,
        success: false,
        actionTaken: 'resumed_submission',
        syncState: 'temporarily_failed',
        invoiceId: existing.id,
        messageArabic: `تعذرت إعادة الإرسال: ${err.message}`,
        messageEnglish: `Re-submission failed: ${err.message}`
      };
    }
  }

  // SAFEGUARD 5: If no invoice exists, check whether order is held in B2B pending queue
  const pendingB2bRes = await client.query(
    `SELECT id, egs_unit_id, order_payload, missing_fields, idempotency_key
     FROM pending_b2b_orders
     WHERE merchant_id = $1 AND order_id = $2 AND status = 'pending_enrichment'
     LIMIT 1`,
    [merchantId, orderId]
  );

  if (pendingB2bRes.rows.length > 0) {
    const row = pendingB2bRes.rows[0];
    const missing = typeof row.missing_fields === 'string' ? JSON.parse(row.missing_fields) : row.missing_fields;

    return {
      orderId,
      success: false,
      actionTaken: 'rejected_ineligible',
      syncState: 'requires_human_review',
      messageArabic: `لا يمكن إصدار الفاتورة تلقائياً لوجود نقص في العنوان الوطني للشركة: ${(missing || []).join('، ')}. يرجى استكمال العنوان من تبويب الشركات B2B.`,
      messageEnglish: `Cannot recover automatically: B2B corporate address missing fields: ${(missing || []).join(', ')}. Complete address in B2B tab first.`,
      details: { missingFields: missing }
    };
  }

  // SAFEGUARD 6: Check pending webhook queue
  const queueRes = await client.query(
    `SELECT id, payload, status, error_message
     FROM webhook_queue
     WHERE merchant_id = $1 AND (payload->'data'->>'id' = $2 OR payload->>'id' = $2)
     ORDER BY created_at DESC LIMIT 1`,
    [merchantId, orderId]
  );

  if (queueRes.rows.length > 0) {
    const qRow = queueRes.rows[0];
    const rawPayload = typeof qRow.payload === 'string' ? JSON.parse(qRow.payload) : qRow.payload;
    const orderData = (rawPayload.data || rawPayload) as SallaOrderData;

    // Check payment deferral rules
    const paymentMethod = orderData.payment_method?.toLowerCase() || '';
    const statusSlug = orderData.status?.slug?.toLowerCase() || '';
    const isDeferred = ['cod', 'cash_on_delivery', 'bank', 'bank_transfer'].includes(paymentMethod);

    if (isDeferred && !['completed', 'delivered'].includes(statusSlug)) {
      await transitionOrderSyncState(client, {
        merchantId,
        orderId,
        toState: 'awaiting_processing',
        sourceEvent: 'manual_recovery',
        reason: 'طلب دفع عند الاستلام أو حوالة لم يكتمل تسليمه بعد / COD/transfer order not yet completed',
        isRecoverable: false,
        nextAction: 'بانتظار تغيير حالة الطلب إلى تم التوصيل أو مكتمل في متجر سلة / Awaiting delivery status in Salla'
      });

      return {
        orderId,
        success: false,
        actionTaken: 'deferred_held',
        syncState: 'awaiting_processing',
        messageArabic: 'هذا الطلب يخضع للدفع عند الاستلام أو الحوالة البنكية، ويؤجل إصدار فاتورته حتى تسليم الطلب للعميل منعاً للفوترة المسبقة.',
        messageEnglish: 'COD or Bank Transfer order held until delivery completion to prevent premature taxation.'
      };
    }

    // Resolve EGS unit
    let resolvedUnit;
    try {
      resolvedUnit = await resolveEgsUnitForOrder(client, { merchantId });
    } catch {
      return {
        orderId,
        success: false,
        actionTaken: 'rejected_ineligible',
        syncState: 'requires_human_review',
        messageArabic: 'لا يوجد جهاز EGS فعال مربوط بمتجر سلة لإصدار الفواتير. يرجى تفعيل الجهاز في تبويب التفعيل أولاً.',
        messageEnglish: 'No active EGS unit found for merchant. Please activate ZATCA unit first.'
      };
    }

    // SAFEGUARD 7 & 8: Safely process order into invoice within mutex and atomic transaction
    await transitionOrderSyncState(client, {
      merchantId,
      orderId,
      toState: 'processing',
      sourceEvent: 'manual_recovery'
    });

    const invResult = await processSallaOrderIntoZatcaInvoice(
      client,
      resolvedUnit.id,
      orderData,
      `recovery_${merchantId}_${orderId}_${Date.now()}`
    );

    // Update sync record to successfully_processed
    await transitionOrderSyncState(client, {
      merchantId,
      orderId,
      toState: 'successfully_processed',
      sourceEvent: 'manual_recovery',
      invoiceId: invResult.invoiceId,
      invoiceUuid: invResult.invoiceUuid,
      invoiceType: invResult.isB2C ? 'simplified_tax_invoice' : 'tax_invoice',
      reason: 'تم إصدار الفاتورة وتوقيعها مشفراً بنجاح أثناء إجراء التعافي / Successfully signed during recovery',
      isRecoverable: true
    });

    // Attempt dispatch to ZATCA
    try {
      const dispatchRes = await submitInvoiceToFatoora(client, invResult.invoiceId);
      const finalState = dispatchRes.status === 'cleared' ? 'successfully_cleared' : 'successfully_reported';
      await transitionOrderSyncState(client, {
        merchantId,
        orderId,
        toState: finalState,
        sourceEvent: 'manual_recovery',
        invoiceId: invResult.invoiceId,
        invoiceUuid: invResult.invoiceUuid,
        invoiceType: invResult.isB2C ? 'simplified_tax_invoice' : 'tax_invoice',
        reason: 'تم توثيق الفاتورة في هيئة الزكاة بنجاح / Successfully verified by ZATCA',
        isRecoverable: false
      });

      return {
        orderId,
        success: true,
        actionTaken: 'invoiced_and_submitted',
        syncState: finalState,
        invoiceId: invResult.invoiceId,
        invoiceUuid: invResult.invoiceUuid,
        icv: invResult.icv,
        messageArabic: `تم توليد الفاتورة برقم تسلسلي (${invResult.icv}) واعتمادها رسمياً من هيئة الزكاة.`,
        messageEnglish: `Invoice generated (ICV ${invResult.icv}) and accepted by ZATCA.`
      };
    } catch {
      // Invoice was signed but dispatch failed: state is temporarily_failed (recoverable via DLQ retry)
      await transitionOrderSyncState(client, {
        merchantId,
        orderId,
        toState: 'temporarily_failed',
        sourceEvent: 'manual_recovery',
        invoiceId: invResult.invoiceId,
        invoiceUuid: invResult.invoiceUuid,
        invoiceType: invResult.isB2C ? 'simplified_tax_invoice' : 'tax_invoice',
        reason: 'تم إصدار الفاتورة مشفرة وتأجل الإرسال لهيئة الزكاة / Invoice signed, ZATCA dispatch queued for retry',
        isRecoverable: true
      });

      return {
        orderId,
        success: true,
        actionTaken: 'invoiced_and_submitted',
        syncState: 'temporarily_failed',
        invoiceId: invResult.invoiceId,
        invoiceUuid: invResult.invoiceUuid,
        icv: invResult.icv,
        messageArabic: `تم توقيع الفاتورة محلياً برقم تسلسلي (${invResult.icv}) وحفظها، وسيتم إرسالها لهيئة الزكاة عبر طابور الإرسال الآلي.`,
        messageEnglish: `Invoice signed with ICV ${invResult.icv} and queued for automated ZATCA dispatch.`
      };
    }
  }

  // SAFEGUARD 9: If order is not present in local tables, return clear explanation
  return {
    orderId,
    success: false,
    actionTaken: 'rejected_ineligible',
    syncState: 'not_received',
    messageArabic: 'لم يتم العثور على بيانات هذا الطلب في السجل المحلي. يرجى تشغيل المطابقة الذكية لاستيراد بيانات الطلب من سلة أولاً.',
    messageEnglish: 'Order data not found locally. Please run Smart Reconciliation to fetch order details from Salla first.'
  };
}

export async function generateOrderSupportDiagnostics(
  client: PoolClient | Pool,
  merchantId: string,
  orderId: string
): Promise<OrderSupportDiagnostics> {
  const syncWithHist = await getOrderSyncWithHistory(client, merchantId, orderId);

  // Fetch ZATCA submission details if invoice exists
  let zatcaSubmissionDetails: OrderSupportDiagnostics['zatcaSubmissionDetails'] = null;

  if (syncWithHist?.invoiceId) {
    const subRes = await client.query(
      `SELECT http_status_code, is_outage_error, submission_timestamp, warning_messages, error_messages
       FROM zatca_submissions
       WHERE invoice_id = $1
       ORDER BY submission_timestamp DESC LIMIT 1`,
      [syncWithHist.invoiceId]
    );

    if (subRes.rows.length > 0) {
      const s = subRes.rows[0];
      zatcaSubmissionDetails = {
        httpStatus: s.http_status_code,
        isOutage: Boolean(s.is_outage_error),
        submissionTimestamp: s.submission_timestamp ? new Date(s.submission_timestamp).toISOString() : undefined,
        parsedWarnings: typeof s.warning_messages === 'string' ? JSON.parse(s.warning_messages) : s.warning_messages,
        parsedErrors: typeof s.error_messages === 'string' ? JSON.parse(s.error_messages) : s.error_messages
      };
    }
  }

  // Build timeline steps
  const timeline: OrderSupportDiagnostics['timeline'] = [];
  if (syncWithHist) {
    syncWithHist.transitions.forEach((t, idx) => {
      timeline.push({
        step: idx + 1,
        state: t.toState,
        event: t.sourceEvent,
        timestamp: t.createdAt.toISOString(),
        reason: t.reason,
        errorCategory: t.errorCategory,
        errorCode: t.errorCode
      });
    });
  }

  // Determine recovery blockers
  const blockers: string[] = [];
  if (!syncWithHist) {
    blockers.push('Order has not been received or recorded locally yet.');
  } else {
    if (syncWithHist.syncState === 'successfully_cleared' || syncWithHist.syncState === 'successfully_reported') {
      blockers.push('Order is already successfully settled with ZATCA.');
    }
    if (syncWithHist.syncState === 'not_eligible') {
      blockers.push('Order is classified as non-taxable or cancelled pre-supply.');
    }
    if (syncWithHist.syncState === 'requires_human_review') {
      blockers.push('Corporate B2B National Address requires merchant enrichment.');
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    orderId,
    merchantId,
    currentSyncState: syncWithHist ? syncWithHist.syncState : 'not_received',
    isRecoverable: syncWithHist ? syncWithHist.isRecoverable : false,
    correlationId: syncWithHist?.correlationId,
    summary: {
      attempts: syncWithHist ? syncWithHist.attemptCount : 0,
      firstSeenAt: syncWithHist ? syncWithHist.createdAt.toISOString() : new Date().toISOString(),
      lastEventAt: syncWithHist ? syncWithHist.lastEventAt.toISOString() : new Date().toISOString(),
      invoiceId: syncWithHist?.invoiceId,
      invoiceUuid: syncWithHist?.invoiceUuid,
      invoiceType: syncWithHist?.invoiceType,
      amount: syncWithHist?.orderAmount,
      currency: syncWithHist?.orderCurrency || 'SAR',
      customerType: syncWithHist?.customerSummary?.isB2B ? 'B2B' : 'B2C'
    },
    eligibility: syncWithHist?.eligibilityDetails || {},
    timeline,
    zatcaSubmissionDetails,
    recoveryEligibility: {
      canRecoverNow: syncWithHist ? (syncWithHist.isRecoverable && blockers.length === 0) : false,
      blockers
    }
  };
}
