import { PoolClient, Pool } from 'pg';
import { getSallaMerchantTokens, refreshSallaTokenIfNeeded } from './salla-oauth.js';
import { transitionOrderSyncState, SyncState } from './sync-service.js';
import { SallaOrderData } from '../types/salla.js';
import { isB2bCustomer, validateB2bBuyerAddress } from './invoice-generator.js';

export interface SallaOrderSummary {
  id: string | number;
  reference_id?: string;
  status: { id: number; name: string; slug: string };
  payment_method: string;
  currency: string;
  amounts: {
    total: { amount: number; currency: string };
  };
  date: { date: string };
  customer?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    company_name?: string;
    tax_number?: string;
  };
  shipping?: {
    address?: {
      country?: string;
      city?: string;
      building_number?: string;
      postal_code?: string;
      street?: string;
      district?: string;
    };
  };
}

export interface ReconciliationOptions {
  fromDate?: string;
  toDate?: string;
  maxPages?: number;
  perPage?: number;
  customFetch?: typeof fetch;
  apiBaseUrl?: string;
}

export interface ReconciliationJob {
  id: string;
  merchantId: string;
  status: 'running' | 'completed' | 'failed';
  fromDate?: Date | null;
  toDate?: Date | null;
  lastCursor?: string | null;
  currentPage: number;
  totalOrdersScanned: number;
  discrepanciesFound: number;
  ordersRecovered: number;
  startedAt: Date;
  completedAt?: Date | null;
  errorMessage?: string | null;
}

export interface ReconciliationDiscrepancy {
  id: string;
  jobId: string;
  merchantId: string;
  orderId: string;
  discrepancyType: 'MISSED_INGESTION' | 'STATUS_MISMATCH' | 'REFUND_NOT_SYNCED' | 'INVOICE_MISSING' | 'INELIGIBLE_SALLA_ORDER';
  details: Record<string, any>;
  resolvedAt?: Date | null;
  resolutionAction?: string | null;
  createdAt: Date;
}

export async function fetchSallaOrdersPage(
  accessToken: string,
  options: {
    page?: number;
    perPage?: number;
    maxPages?: number;
    fromDate?: string;
    toDate?: string;
    status?: string;
    apiBaseUrl?: string;
    customFetch?: typeof fetch;
  } = {}
): Promise<{ orders: SallaOrderSummary[]; hasMore: boolean; nextPage: number | null }> {
  const page = options.page || 1;
  const perPage = options.perPage || 20;
  const apiBaseUrl = options.apiBaseUrl || 'https://api.salla.dev/admin/v2';
  const customFetch = options.customFetch || fetch;

  const url = new URL(`${apiBaseUrl}/orders`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  if (options.fromDate) url.searchParams.set('from_date', options.fromDate);
  if (options.toDate) url.searchParams.set('to_date', options.toDate);
  if (options.status) url.searchParams.set('status', options.status);

  if (process.env.NODE_ENV === 'production') {
    if (!accessToken || accessToken.includes('demo') || accessToken.includes('test')) {
      throw new Error('PRODUCTION_CREDENTIAL_ERROR: Valid Salla OAuth access token required in production environment.');
    }
  }

  // In test or offline demo environment without real token and without customFetch, return synthetic store orders
  if (!options.customFetch && (accessToken.includes('demo') || accessToken.includes('test') || process.env.NODE_ENV === 'test')) {
    return {
      orders: [
        {
          id: `DEMO-ORD-${1000 + page * 10 + 1}`,
          reference_id: `REF-${1000 + page * 10 + 1}`,
          status: { id: 1, name: 'Delivered', slug: 'delivered' },
          payment_method: 'credit_card',
          currency: 'SAR',
          amounts: { total: { amount: 350.0, currency: 'SAR' } },
          date: { date: new Date().toISOString() },
          customer: { first_name: 'عميل', last_name: 'سلة', tax_number: undefined }
        },
        {
          id: `DEMO-ORD-${1000 + page * 10 + 2}`,
          reference_id: `REF-${1000 + page * 10 + 2}`,
          status: { id: 2, name: 'Completed', slug: 'completed' },
          payment_method: 'cod',
          currency: 'SAR',
          amounts: { total: { amount: 500.0, currency: 'SAR' } },
          date: { date: new Date().toISOString() },
          customer: { first_name: 'مؤسسة', last_name: 'الأعمال', company_name: 'مؤسسة الأعمال المحدودة', tax_number: '300000000000003' }
        }
      ],
      hasMore: page < (options.maxPages || 2),
      nextPage: page < (options.maxPages || 2) ? page + 1 : null
    };
  }

  const response = await customFetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'ZATCA-Salla-Bridge/1.0.0 (Reconciliation Engine)'
    }
  });

  if (!response.ok) {
    throw new Error(`Salla Orders API responded with status ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as any;
  const data = Array.isArray(json.data) ? json.data : [];
  const pagination = json.pagination || {};
  const totalPages = pagination.totalPages || pagination.total_pages || 1;
  const hasMore = page < totalPages;

  return {
    orders: data,
    hasMore,
    nextPage: hasMore ? page + 1 : null
  };
}

export async function runStoreReconciliation(
  client: PoolClient | Pool,
  merchantId: string,
  options: ReconciliationOptions = {}
): Promise<{
  jobId: string;
  status: 'completed' | 'failed';
  totalScanned: number;
  discrepanciesCount: number;
  discrepancies: ReconciliationDiscrepancy[];
}> {
  // 1. Get or refresh Salla tokens
  const tokens = await refreshSallaTokenIfNeeded(client, merchantId);
  if (process.env.NODE_ENV === 'production' && !tokens?.accessToken) {
    throw new Error(`AUTHENTICATION_REQUIRED: No active Salla OAuth access token found for merchant ${merchantId} in production.`);
  }
  const accessToken = tokens?.accessToken || 'demo_token';

  // 2. Check for existing running job to resume, or create new
  const activeJobRes = await client.query(
    `SELECT id, current_page, total_orders_scanned, discrepancies_found
     FROM salla_reconciliation_jobs
     WHERE merchant_id = $1 AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
    [merchantId]
  );

  let jobId: string;
  let startPage = 1;
  let totalScanned = 0;
  let discrepanciesCount = 0;

  if (activeJobRes.rows.length > 0) {
    const active = activeJobRes.rows[0];
    jobId = active.id;
    startPage = Number(active.current_page);
    totalScanned = Number(active.total_orders_scanned);
    discrepanciesCount = Number(active.discrepancies_found);
  } else {
    const jobRes = await client.query(
      `INSERT INTO salla_reconciliation_jobs (
        merchant_id, status, from_date, to_date, current_page,
        total_orders_scanned, discrepancies_found, orders_recovered, started_at
      ) VALUES ($1, 'running', $2, $3, 1, 0, 0, 0, NOW())
      RETURNING id`,
      [
        merchantId,
        options.fromDate ? new Date(options.fromDate).toISOString() : null,
        options.toDate ? new Date(options.toDate).toISOString() : null
      ]
    );
    jobId = jobRes.rows[0].id;
  }

  const maxPages = options.maxPages || 5;
  let currentPage = startPage;
  let hasMorePages = true;
  const collectedDiscrepancies: ReconciliationDiscrepancy[] = [];

  try {
    while (hasMorePages && currentPage <= maxPages) {
      const pageResult = await fetchSallaOrdersPage(accessToken, {
        page: currentPage,
        perPage: options.perPage || 20,
        fromDate: options.fromDate,
        toDate: options.toDate,
        apiBaseUrl: options.apiBaseUrl,
        customFetch: options.customFetch
      });

      for (const sallaOrder of pageResult.orders) {
        totalScanned++;
        const orderId = sallaOrder.id.toString();
        const statusSlug = sallaOrder.status?.slug?.toLowerCase() || '';
        const paymentMethod = sallaOrder.payment_method?.toLowerCase() || '';
        const isB2b = isB2bCustomer(sallaOrder.customer?.tax_number);
        const orderAmount = sallaOrder.amounts?.total?.amount || 0;

        // Check if invoice exists locally in invoices table
        const localInvoiceRes = await client.query(
          `SELECT i.id, i.uuid, i.icv, i.status, i.invoice_type
           FROM invoices i
           JOIN egs_units u ON i.egs_unit_id = u.id
           WHERE u.merchant_id = $1 AND i.order_id = $2
           ORDER BY i.created_at DESC LIMIT 1`,
          [merchantId, orderId]
        );

        // Check current sync record
        const syncRecRes = await client.query(
          `SELECT id, sync_state FROM order_sync_records
           WHERE merchant_id = $1 AND order_id = $2`,
          [merchantId, orderId]
        );

        const hasInvoice = localInvoiceRes.rows.length > 0;
        const localInvoice = hasInvoice ? localInvoiceRes.rows[0] : null;

        // SAFE EVALUATION: Compare Salla state vs Local state
        if (hasInvoice) {
          // If invoice is already cleared or reported, update sync record if outdated
          const invStatus = localInvoice.status;
          const targetSyncState: SyncState = invStatus.startsWith('cleared')
            ? 'successfully_cleared'
            : invStatus.startsWith('reported')
            ? 'successfully_reported'
            : 'successfully_processed';

          if (syncRecRes.rows.length === 0 || syncRecRes.rows[0].sync_state !== targetSyncState) {
            await transitionOrderSyncState(client, {
              merchantId,
              orderId,
              toState: targetSyncState,
              sourceEvent: 'reconciliation',
              invoiceId: localInvoice.id,
              invoiceUuid: localInvoice.uuid,
              invoiceType: localInvoice.invoice_type,
              orderAmount,
              reason: 'تم مزامنة حالة الفاتورة المحلية مع سجل المزامنة / Reconciled existing invoice record'
            });
          }
        } else {
          // No invoice exists locally. Evaluate why and classify discrepancy
          const isEligiblePrepaid = !['cod', 'cash_on_delivery', 'bank', 'bank_transfer'].includes(paymentMethod) &&
            ['paid', 'completed', 'delivered', 'in_progress', 'shipping'].includes(statusSlug);

          const isEligibleCod = ['cod', 'cash_on_delivery', 'bank', 'bank_transfer'].includes(paymentMethod) &&
            ['completed', 'delivered'].includes(statusSlug);

          if (isEligiblePrepaid || isEligibleCod) {
            // Check if held in B2B pending enrichment
            if (isB2b) {
              const b2bValidation = validateB2bBuyerAddress(sallaOrder as any);
              if (!b2bValidation.isValid) {
                // Not a missing order - it is legitimately held
                await transitionOrderSyncState(client, {
                  merchantId,
                  orderId,
                  toState: 'requires_human_review',
                  sourceEvent: 'reconciliation',
                  orderAmount,
                  reason: `طلب شركات B2B بانتظار استكمال العنوان الوطني: ${b2bValidation.missingFields.join(', ')}`,
                  isRecoverable: true
                });
                continue;
              }
            }

            // Order was genuinely missed or failed!
            discrepanciesCount++;
            const discRes = await client.query(
              `INSERT INTO salla_reconciliation_discrepancies (
                job_id, merchant_id, order_id, discrepancy_type, details, resolution_action, created_at
              ) VALUES ($1, $2, $3, 'MISSED_INGESTION', $4::jsonb, $5, NOW())
              RETURNING id`,
              [
                jobId,
                merchantId,
                orderId,
                JSON.stringify({
                  sallaStatus: statusSlug,
                  paymentMethod,
                  orderAmount,
                  currency: sallaOrder.currency,
                  isB2B: isB2b
                }),
                'طلب مؤهل لم يفوتر محلياً. متاح لإجراء التعافي الآمن / Eligible un-invoiced order. Available for Safe Recovery.'
              ]
            );

            collectedDiscrepancies.push({
              id: discRes.rows[0].id,
              jobId,
              merchantId,
              orderId,
              discrepancyType: 'MISSED_INGESTION',
              details: { sallaStatus: statusSlug, paymentMethod, orderAmount },
              resolutionAction: 'طلب مؤهل متاح لإجراء التعافي الآمن',
              createdAt: new Date()
            });

            // Mark in order_sync_records as temporarily_failed / recoverable
            await transitionOrderSyncState(client, {
              merchantId,
              orderId,
              toState: 'temporarily_failed',
              sourceEvent: 'reconciliation',
              orderAmount,
              reason: 'تم رصد تخلف استلام حدث الفوترة أثناء المطابقة الذكية / Discrepancy detected during reconciliation',
              isRecoverable: true,
              nextAction: 'متاح للتاجر لطلب إعادة المحاولة والفوترة الآمنة / Available for Safe Recovery request'
            });
          } else {
            // Not eligible (e.g. COD pending delivery, cancelled pre-supply, draft)
            await transitionOrderSyncState(client, {
              merchantId,
              orderId,
              toState: 'not_eligible',
              sourceEvent: 'reconciliation',
              orderAmount,
              reason: `طلب غير مؤهل للفوترة حالياً: حالة الطلب (${statusSlug}) وطريقة الدفع (${paymentMethod})`,
              isRecoverable: false
            });
          }
        }
      }

      hasMorePages = pageResult.hasMore;
      currentPage = pageResult.nextPage || (currentPage + 1);

      // Persist checkpoint progress
      await client.query(
        `UPDATE salla_reconciliation_jobs
         SET current_page = $1,
             total_orders_scanned = $2,
             discrepancies_found = $3
         WHERE id = $4`,
        [currentPage, totalScanned, discrepanciesCount, jobId]
      );
    }

    // Complete job successfully
    await client.query(
      `UPDATE salla_reconciliation_jobs
       SET status = 'completed',
           completed_at = NOW(),
           total_orders_scanned = $1,
           discrepancies_found = $2
       WHERE id = $3`,
      [totalScanned, discrepanciesCount, jobId]
    );

    return {
      jobId,
      status: 'completed',
      totalScanned,
      discrepanciesCount,
      discrepancies: collectedDiscrepancies
    };
  } catch (err: any) {
    await client.query(
      `UPDATE salla_reconciliation_jobs
       SET status = 'failed',
           error_message = $1,
           completed_at = NOW()
       WHERE id = $2`,
      [err.message, jobId]
    );

    return {
      jobId,
      status: 'failed',
      totalScanned,
      discrepanciesCount,
      discrepancies: collectedDiscrepancies
    };
  }
}

export async function getLatestReconciliationSummary(
  client: PoolClient | Pool,
  merchantId: string
): Promise<{
  latestJob: ReconciliationJob | null;
  recentDiscrepancies: ReconciliationDiscrepancy[];
}> {
  const jobRes = await client.query(
    `SELECT * FROM salla_reconciliation_jobs
     WHERE merchant_id = $1
     ORDER BY started_at DESC LIMIT 1`,
    [merchantId]
  );

  if (jobRes.rows.length === 0) {
    return { latestJob: null, recentDiscrepancies: [] };
  }

  const j = jobRes.rows[0];
  const discRes = await client.query(
    `SELECT * FROM salla_reconciliation_discrepancies
     WHERE job_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [j.id]
  );

  return {
    latestJob: {
      id: j.id,
      merchantId: j.merchant_id,
      status: j.status,
      fromDate: j.from_date ? new Date(j.from_date) : null,
      toDate: j.to_date ? new Date(j.to_date) : null,
      lastCursor: j.last_cursor,
      currentPage: Number(j.current_page),
      totalOrdersScanned: Number(j.total_orders_scanned),
      discrepanciesFound: Number(j.discrepancies_found),
      ordersRecovered: Number(j.orders_recovered),
      startedAt: new Date(j.started_at),
      completedAt: j.completed_at ? new Date(j.completed_at) : null,
      errorMessage: j.error_message
    },
    recentDiscrepancies: discRes.rows.map((d: any) => ({
      id: d.id,
      jobId: d.job_id,
      merchantId: d.merchant_id,
      orderId: d.order_id,
      discrepancyType: d.discrepancy_type,
      details: typeof d.details === 'string' ? JSON.parse(d.details) : d.details,
      resolvedAt: d.resolved_at ? new Date(d.resolved_at) : null,
      resolutionAction: d.resolution_action,
      createdAt: new Date(d.created_at)
    }))
  };
}
