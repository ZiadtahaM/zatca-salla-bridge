import { PoolClient, Pool } from 'pg';
import { decryptVaultSecret } from '../crypto/vault.js';
import { getZatcaOutboundHeaders, classifyGatewayResponse, HttpResponse } from './outage-classifier.js';
import { getZatcaBaseUrl, ZatcaEnvironment } from './csr-generator.js';
import { recordSubmissionFailure } from './dlq-monitor.js';
import { refreshSallaTokenIfNeeded } from './salla-oauth.js';

export interface FatooraDispatchOptions {
  httpClient?: (url: string, init: any) => Promise<HttpResponse>;
  sallaApiBase?: string;
  appBaseUrl?: string;
  customFetch?: typeof fetch;
}

export interface FatooraDispatchResult {
  invoiceId: string;
  invoiceUuid: string;
  status: 'cleared' | 'reported' | 'duplicate_recovered' | 'queued_dlq_retry' | 'rejected' | 'cleared_bypass' | 'rejected_reporting';
  httpStatus?: number;
  clearedXml?: string | null;
  qrCode?: string | null;
  warnings?: any[];
  errors?: any[];
  retryAfterSeconds?: number;
  message?: string;
}

export function extractQrFromClearedXml(xml: string): string | null {
  if (!xml || typeof xml !== 'string') return null;
  const qrSectionMatch = /<cac:AdditionalDocumentReference>[\s\S]*?<cbc:ID>QR<\/cbc:ID>[\s\S]*?<cbc:EmbeddedDocumentBinaryObject[^>]*>([\s\S]*?)<\/cbc:EmbeddedDocumentBinaryObject>[\s\S]*?<\/cac:AdditionalDocumentReference>/i.exec(xml);
  if (qrSectionMatch && qrSectionMatch[1]) {
    return qrSectionMatch[1].trim();
  }
  const fallbackMatch = /<cbc:EmbeddedDocumentBinaryObject[^>]*>([A-Za-z0-9+/=]{20,})<\/cbc:EmbeddedDocumentBinaryObject>/i.exec(xml);
  if (fallbackMatch && fallbackMatch[1]) {
    return fallbackMatch[1].trim();
  }
  return null;
}

export async function submitInvoiceToFatoora(
  client: PoolClient | Pool,
  invoiceId: string,
  options: FatooraDispatchOptions = {}
): Promise<FatooraDispatchResult> {
  const invoiceRes = await client.query(
    `SELECT i.id, i.uuid, i.order_id, i.invoice_type, i.invoice_hash, i.signed_xml,
            i.qr_code_payload, i.status, i.egs_unit_id,
            u.merchant_id, u.branch_id, u.certificate, u.csid_secret, u.csid_environment
     FROM invoices i
     JOIN egs_units u ON i.egs_unit_id = u.id
     WHERE i.id = $1`,
    [invoiceId]
  );

  if (invoiceRes.rows.length === 0) {
    throw new Error(`Invoice with id ${invoiceId} not found`);
  }

  const row = invoiceRes.rows[0];
  const isB2B = row.invoice_type === 'tax_invoice';
  const environment = (row.csid_environment as ZatcaEnvironment) || 'production';
  const zatcaBaseUrl = getZatcaBaseUrl(environment);

  const endpointPath = isB2B ? '/invoices/clearance/single' : '/invoices/reporting/single';
  const targetUrl = `${zatcaBaseUrl}${endpointPath}`;

  const cleanCert = row.certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  const decryptedSecret = decryptVaultSecret(row.csid_secret);
  const basicAuthCredentials = Buffer.from(`${cleanCert}:${decryptedSecret}`).toString('base64');
  const headers = getZatcaOutboundHeaders(basicAuthCredentials, environment === 'sandbox');

  const requestPayload = {
    invoiceHash: row.invoice_hash,
    uuid: row.uuid,
    invoice: Buffer.from(row.signed_xml, 'utf8').toString('base64')
  };

  const bodyJson = JSON.stringify(requestPayload);

  let httpResponse: HttpResponse;

  if (options.httpClient) {
    httpResponse = await options.httpClient(targetUrl, {
      method: 'POST',
      headers,
      body: bodyJson
    });
  } else {
    const fetchFn = options.customFetch || fetch;
    try {
      const resp = await fetchFn(targetUrl, {
        method: 'POST',
        headers,
        body: bodyJson
      });
      const rawBody = await resp.text();
      const responseHeaders: Record<string, string> = {};
      resp.headers.forEach((val, key) => {
        responseHeaders[key.toLowerCase()] = val;
      });

      httpResponse = {
        statusCode: resp.status,
        headers: responseHeaders,
        rawBody
      };
    } catch (err: any) {
      httpResponse = {
        statusCode: 503,
        headers: { 'content-type': 'application/json' },
        rawBody: JSON.stringify({ error: 'Network transport failure', details: err.message })
      };
    }
  }

  const verdict = classifyGatewayResponse(httpResponse);

  // 1. Clean success or success with non-blocking warnings
  if (verdict.kind === 'success_clean' || verdict.kind === 'success_with_warnings') {
    const responseData = verdict.data || {};
    let finalClearedXml = null;
    let finalQrCode = row.qr_code_payload;

    if (isB2B && responseData.clearedInvoice) {
      try {
        finalClearedXml = Buffer.from(responseData.clearedInvoice, 'base64').toString('utf8');
      } catch {
        finalClearedXml = responseData.clearedInvoice;
      }
      if (finalClearedXml) {
        const extractedQr = extractQrFromClearedXml(finalClearedXml);
        if (extractedQr) {
          finalQrCode = extractedQr;
        }
      }
    }

    if (responseData.qrSellertag) {
      finalQrCode = responseData.qrSellertag;
    }

    const newStatus = isB2B ? 'cleared' : 'reported';

    await client.query(
      `UPDATE invoices
       SET status = $1,
           cleared_xml = COALESCE($2, cleared_xml),
           qr_code_payload = COALESCE($3, qr_code_payload),
           updated_at = NOW()
       WHERE id = $4`,
      [newStatus, finalClearedXml, finalQrCode, invoiceId]
    );

    // Resolve any active DLQ entry
    await client.query(
      `UPDATE zatca_dlq
       SET resolved_at = NOW()
       WHERE invoice_id = $1 AND resolved_at IS NULL`,
      [invoiceId]
    );

    // Notify Salla order timeline with the verified invoice link
    await notifySallaOrderTimeline(
      client,
      row.merchant_id,
      row.order_id,
      row.uuid,
      options.sallaApiBase,
      options.appBaseUrl,
      options.customFetch
    );

    return {
      invoiceId,
      invoiceUuid: row.uuid,
      status: newStatus,
      httpStatus: httpResponse.statusCode,
      clearedXml: finalClearedXml,
      qrCode: finalQrCode,
      warnings: verdict.kind === 'success_with_warnings' ? verdict.warnings : undefined
    };
  }

  // 2. Recovery on HTTP 409 Duplicate UUID
  if (verdict.kind === 'duplicate_uuid_recovered') {
    const recoveryStatus = isB2B ? 'cleared' : 'reported';
    await client.query(
      `UPDATE invoices
       SET status = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [recoveryStatus, invoiceId]
    );

    await client.query(
      `UPDATE zatca_dlq
       SET resolved_at = NOW()
       WHERE invoice_id = $1 AND resolved_at IS NULL`,
      [invoiceId]
    );

    return {
      invoiceId,
      invoiceUuid: row.uuid,
      status: 'duplicate_recovered',
      httpStatus: 409,
      message: verdict.message
    };
  }

  // 2b. HTTP 303 Clearance Bypass / Fallback
  if (verdict.kind === 'clearance_fallback_303') {
    const fallbackStatus = isB2B ? 'cleared_bypass' : 'reported';
    await client.query(
      `UPDATE invoices
       SET status = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [fallbackStatus, invoiceId]
    );

    return {
      invoiceId,
      invoiceUuid: row.uuid,
      status: fallbackStatus,
      httpStatus: 303,
      message: `ZATCA clearance redirected or bypassed: ${verdict.redirectLocation || 'standard reporting fallback'}`
    };
  }

  // 3. Transient failure or gateway outage: route to DLQ with backpressure retry window
  if (verdict.kind === 'outage_retry') {
    const retryDelaySec = verdict.retryAfterSeconds || 30;
    const nextRetryAt = new Date(Date.now() + retryDelaySec * 1000);

    const dlqId = await recordSubmissionFailure(client, {
      invoiceId,
      merchantId: row.merchant_id,
      egsUnitId: row.egs_unit_id,
      failureReason: verdict.reason,
      httpStatus: httpResponse.statusCode
    });

    await client.query(
      `UPDATE zatca_dlq
       SET next_retry_at = $1
       WHERE id = $2`,
      [nextRetryAt.toISOString(), dlqId]
    );

    return {
      invoiceId,
      invoiceUuid: row.uuid,
      status: 'queued_dlq_retry',
      httpStatus: httpResponse.statusCode,
      retryAfterSeconds: retryDelaySec,
      message: verdict.reason
    };
  }

  // 4. Hard business rejection or authentication failure
  // In accordance with ZATCA Phase 2:
  // - Standard B2B clearance rejection (HTTP 400): document is NOT issued to the buyer. Status = 'rejected'.
  //   The rejected document remains immutable; resubmission creates a new document with new UUID/ICV and PIH = rejected hash.
  // - Simplified B2C reporting rejection (HTTP 400): document was already delivered to consumer. Status = 'rejected_reporting'.
  //   Flagged for human review and credit note adjustment under VAT Regulations Articles 40 & 54.
  const rejectionReason =
    verdict.kind === 'auth_error_401'
      ? verdict.reason
      : JSON.stringify((verdict as any).errors || httpResponse.rawBody);

  const rejectionStatus = isB2B ? 'rejected' : 'rejected_reporting';

  await client.query(
    `UPDATE invoices
     SET status = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [rejectionStatus, invoiceId]
  );

  await recordSubmissionFailure(client, {
    invoiceId,
    merchantId: row.merchant_id,
    egsUnitId: row.egs_unit_id,
    failureReason: rejectionReason,
    httpStatus: httpResponse.statusCode
  });

  return {
    invoiceId,
    invoiceUuid: row.uuid,
    status: rejectionStatus,
    httpStatus: httpResponse.statusCode,
    errors: (verdict as any).errors,
    message: rejectionReason
  };
}

export async function notifySallaOrderTimeline(
  client: PoolClient | Pool,
  merchantId: string,
  orderId: string,
  invoiceUuid: string,
  sallaApiBase: string = 'https://api.salla.dev/admin/v2',
  appBaseUrl: string = process.env.APP_BASE_URL || 'http://localhost:3000',
  customFetch: typeof fetch = fetch
): Promise<boolean> {
  try {
    const tokenRecord = await refreshSallaTokenIfNeeded(client, merchantId, false, customFetch);
    if (!tokenRecord) {
      return false;
    }

    const pdfDownloadUrl = `${appBaseUrl}/api/invoices/${invoiceUuid}/pdf`;
    const noteText = `تم اعتماد الفاتورة الضريبية رسمياً من هيئة الزكاة والضريبة والجمارك (ZATCA).\nرابط تحميل الفاتورة المعتمدة PDF/A-3: ${pdfDownloadUrl}`;

    const res = await customFetch(`${sallaApiBase}/orders/${orderId}/histories`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenRecord.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        event: 'zatca_einvoice_issued',
        note: noteText,
        is_private: false
      })
    });

    return res.ok;
  } catch {
    // Non-blocking for offline or simulated environments
    return false;
  }
}

export async function processPendingDlqRetries(
  pool: Pool,
  options: FatooraDispatchOptions = {}
): Promise<{ retriedCount: number; resolvedCount: number; failedCount: number }> {
  const client = await pool.connect();
  try {
    const pendingRes = await client.query(
      `SELECT id, invoice_id, merchant_id, attempt_count
       FROM zatca_dlq
       WHERE resolved_at IS NULL
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY first_failed_at ASC
       LIMIT 50`
    );

    let retriedCount = 0;
    let resolvedCount = 0;
    let failedCount = 0;

    for (const item of pendingRes.rows) {
      retriedCount++;
      const result = await submitInvoiceToFatoora(client, item.invoice_id, options);
      if (result.status === 'cleared' || result.status === 'reported' || result.status === 'duplicate_recovered') {
        resolvedCount++;
      } else {
        failedCount++;
      }
    }

    return { retriedCount, resolvedCount, failedCount };
  } finally {
    client.release();
  }
}
