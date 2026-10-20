import { Pool, PoolClient } from 'pg';

export interface DlqRecordParams {
  invoiceId: string;
  merchantId: string;
  egsUnitId: string;
  failureReason: string;
  httpStatus?: number;
}

export interface DlqStallAlert {
  dlqId: string;
  invoiceId: string;
  merchantId: string;
  egsUnitId: string;
  failureReason: string;
  httpStatus?: number;
  attemptCount: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  minutesStalled: number;
  urgency: 'HIGH_STALLED_30M' | 'CRITICAL_WINDOW_CLOSING';
  messageEn: string;
  messageAr: string;
}

/**
 * Records an invoice submission failure into the persistent Dead Letter Queue.
 * Automatically tracks consecutive failure count and detects backpressure stalls.
 */
export async function recordSubmissionFailure(
  client: PoolClient | Pool,
  params: DlqRecordParams
): Promise<string> {
  const { invoiceId, merchantId, egsUnitId, failureReason, httpStatus } = params;

  const existingRes = await client.query(
    `SELECT id, first_failed_at, attempt_count 
     FROM zatca_dlq 
     WHERE invoice_id = $1 AND resolved_at IS NULL 
     LIMIT 1`,
    [invoiceId]
  );

  if (existingRes.rows.length > 0) {
    const row = existingRes.rows[0];
    const firstFailedAt = new Date(row.first_failed_at);
    const diffMinutes = (Date.now() - firstFailedAt.getTime()) / (1000 * 60);
    const isStalled = diffMinutes >= 30;

    await client.query(
      `UPDATE zatca_dlq
       SET attempt_count = attempt_count + 1,
           last_failed_at = NOW(),
           failure_reason = $1,
           http_status = $2,
           is_stalled = $3
       WHERE id = $4`,
      [failureReason, httpStatus || null, isStalled, row.id]
    );

    return row.id;
  }

  const insertRes = await client.query(
    `INSERT INTO zatca_dlq (
       invoice_id, merchant_id, egs_unit_id, failure_reason, http_status, attempt_count, is_stalled
     ) VALUES ($1, $2, $3, $4, $5, 1, FALSE)
     RETURNING id`,
    [invoiceId, merchantId, egsUnitId, failureReason, httpStatus || null]
  );

  return insertRes.rows[0].id;
}

/**
 * Scans the DLQ for any submissions stalled for more than stallThresholdMinutes (default: 30 mins).
 * Emits actionable alerts to prevent violating ZATCA's 24-hour statutory reporting deadline.
 */
export async function checkStalledDlqInvoices(
  pool: Pool,
  stallThresholdMinutes = 30
): Promise<DlqStallAlert[]> {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT id, invoice_id, merchant_id, egs_unit_id, failure_reason, http_status, 
              attempt_count, first_failed_at, last_failed_at, alerted_at
       FROM zatca_dlq
       WHERE resolved_at IS NULL 
         AND first_failed_at <= NOW() - ($1 || ' minutes')::INTERVAL
       ORDER BY first_failed_at ASC`,
      [stallThresholdMinutes]
    );

    const alerts: DlqStallAlert[] = [];
    const now = Date.now();

    for (const row of res.rows) {
      const firstFailedAt = new Date(row.first_failed_at);
      const minutesStalled = Math.round((now - firstFailedAt.getTime()) / (1000 * 60));
      const hoursStalled = minutesStalled / 60;

      const urgency: 'HIGH_STALLED_30M' | 'CRITICAL_WINDOW_CLOSING' =
        hoursStalled >= 20 ? 'CRITICAL_WINDOW_CLOSING' : 'HIGH_STALLED_30M';

      await client.query(
        `UPDATE zatca_dlq 
         SET is_stalled = TRUE, alerted_at = NOW() 
         WHERE id = $1`,
        [row.id]
      );

      alerts.push({
        dlqId: row.id,
        invoiceId: row.invoice_id,
        merchantId: row.merchant_id,
        egsUnitId: row.egs_unit_id,
        failureReason: row.failure_reason,
        httpStatus: row.http_status,
        attemptCount: row.attempt_count,
        firstFailedAt,
        lastFailedAt: new Date(row.last_failed_at),
        minutesStalled,
        urgency,
        messageEn: urgency === 'CRITICAL_WINDOW_CLOSING'
          ? `CRITICAL: Invoice ${row.invoice_id} for merchant ${row.merchant_id} stalled for ${minutesStalled}m. 24h statutory window closing!`
          : `WARNING: Invoice ${row.invoice_id} for merchant ${row.merchant_id} has been stalled in DLQ for ${minutesStalled}m.`,
        messageAr: urgency === 'CRITICAL_WINDOW_CLOSING'
          ? `خطر شديد: الفاتورة ${row.invoice_id} للمتجر ${row.merchant_id} معلقة منذ ${minutesStalled} دقيقة ومهلة الـ 24 ساعة النظامية تشارف على الانتهاء!`
          : `تنبيه: الفاتورة ${row.invoice_id} للمتجر ${row.merchant_id} عالقة في طابور الأخطاء منذ ${minutesStalled} دقيقة.`
      });
    }

    return alerts;
  } finally {
    client.release();
  }
}

/**
 * Marks a DLQ item as resolved after successful replay or manual intervention.
 */
export async function resolveDlqInvoice(client: PoolClient | Pool, dlqId: string): Promise<boolean> {
  const res = await client.query(
    `UPDATE zatca_dlq 
     SET resolved_at = NOW(), is_stalled = FALSE 
     WHERE id = $1 AND resolved_at IS NULL`,
    [dlqId]
  );
  return (res.rowCount ?? 0) > 0;
}
