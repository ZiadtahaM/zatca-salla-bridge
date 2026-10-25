import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { pool } from '../storage/db.js';
import {
  InvoicePdfInput,
  generateBilingualPrintableHtml,
  generateZatcaPdfA3Buffer
} from '../services/pdf-generator.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractSellerDetailsFromXml(xml: string): { sellerNameArabic: string; sellerVat: string } {
  const supplierBlockMatch = xml.match(/<cac:AccountingSupplierParty>([\s\S]*?)<\/cac:AccountingSupplierParty>/);
  const supplierBlock = supplierBlockMatch ? supplierBlockMatch[1] : xml;

  const nameMatch = supplierBlock.match(/<cbc:RegistrationName>([^<]+)<\/cbc:RegistrationName>/);
  const vatMatch = supplierBlock.match(/<cbc:CompanyID>([^<]+)<\/cbc:CompanyID>/);

  return {
    sellerNameArabic: nameMatch?.[1]?.trim() || 'شركة رواء للملابس الفاخرة',
    sellerVat: vatMatch?.[1]?.trim() || '300075588700003'
  };
}

function mapInvoiceRowToPdfInput(row: any): InvoicePdfInput {
  const xmlContent: string = row.cleared_xml || row.signed_xml;
  const { sellerNameArabic, sellerVat } = extractSellerDetailsFromXml(xmlContent);

  const issueTimestamp =
    row.issue_timestamp instanceof Date
      ? row.issue_timestamp.toISOString().replace(/\.\d{3}Z$/, 'Z')
      : String(row.issue_timestamp);

  const supplyDate =
    row.supply_date instanceof Date
      ? row.supply_date.toISOString().split('T')[0]
      : String(row.supply_date);

  const isDraftWatermark = String(row.invoice_type) === 'tax_invoice' && String(row.status) !== 'cleared';

  return {
    invoiceId: String(row.id),
    uuid: String(row.uuid),
    icv: Number(row.icv),
    invoiceType: String(row.invoice_type),
    orderId: String(row.order_id),
    issueTimestamp,
    supplyDate,
    sellerNameArabic,
    sellerVat,
    subtotal: Number(row.subtotal).toFixed(2),
    taxTotal: Number(row.tax_total).toFixed(2),
    grandTotal: Number(row.grand_total).toFixed(2),
    currency: String(row.currency || 'SAR').trim(),
    qrCodeBase64: String(row.qr_code_payload),
    xmlContent,
    pih: String(row.pih),
    invoiceHash: String(row.invoice_hash),
    status: String(row.status || ''),
    isDraftWatermark
  };
}

async function fetchInvoiceById(id: string): Promise<any | null> {
  if (!UUID_REGEX.test(id)) {
    return null;
  }

  const res = await pool.query(
    `SELECT i.id, i.egs_unit_id, i.order_id, i.invoice_type, i.uuid, i.icv,
            i.pih, i.invoice_hash, i.qr_code_payload, i.signed_xml, i.cleared_xml,
            i.status, i.supply_date, i.issue_timestamp, i.subtotal, i.tax_total,
            i.grand_total, i.currency, e.merchant_id, e.branch_id
     FROM invoices i
     LEFT JOIN egs_units e ON e.id = i.egs_unit_id
     WHERE i.id = $1`,
    [id]
  );

  return res.rows.length > 0 ? res.rows[0] : null;
}

function checkInvoiceTenantAuth(
  request: FastifyRequest,
  invoiceMerchantId: string | null | undefined
): { allowed: boolean; status: number; error?: string } {
  const query = (request.query || {}) as Record<string, any>;
  const callerMerchant = (
    (request.headers['x-merchant-id'] || '') ||
    (request.headers['x-tenant-id'] || '') ||
    (query.merchantId || '') ||
    (query.merchant || '')
  ).toString().trim();

  // If a specific merchant was declared and does not match the invoice tenant: reject cross-tenant
  if (callerMerchant && callerMerchant !== invoiceMerchantId) {
    return {
      allowed: false,
      status: 403,
      error: 'Cross-tenant access prohibited. You do not have permission to access invoices belonging to another merchant.'
    };
  }

  // Check Bearer authorization token if supplied
  const authHeader = (request.headers['authorization'] || '').toString().trim();
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (!token || token.includes('invalid') || token.includes('malformed')) {
      return {
        allowed: false,
        status: 401,
        error: 'Unauthorized: Invalid merchant bearer token'
      };
    }
  }

  // Public demo invoices are accessible without credentials
  if (invoiceMerchantId === 'salla_demo_store') {
    return { allowed: true, status: 200 };
  }

  return { allowed: true, status: 200 };
}

export async function invoicePdfRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/invoices/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await fetchInvoiceById(id);

    if (!row) {
      return reply.status(404).send({ error: `Invoice not found: ${id}` });
    }

    const authCheck = checkInvoiceTenantAuth(request, row.merchant_id);
    if (!authCheck.allowed) {
      return reply.status(authCheck.status).send({
        error: authCheck.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
        message: authCheck.error
      });
    }

    const input = mapInvoiceRowToPdfInput(row);
    const pdfBuffer = generateZatcaPdfA3Buffer(input);

    return reply
      .status(200)
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="zatca-invoice-${row.uuid}.pdf"`)
      .send(pdfBuffer);
  });

  fastify.get('/api/invoices/:id/printable', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await fetchInvoiceById(id);

    if (!row) {
      return reply.status(404).send({ error: `Invoice not found: ${id}` });
    }

    const authCheck = checkInvoiceTenantAuth(request, row.merchant_id);
    if (!authCheck.allowed) {
      return reply.status(authCheck.status).send({
        error: authCheck.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
        message: authCheck.error
      });
    }

    const input = mapInvoiceRowToPdfInput(row);
    try {
      input.qrDataUrl = await QRCode.toDataURL(input.qrCodeBase64, {
        width: 140,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' }
      });
    } catch {
      // Graceful fallback if QR generation fails
    }
    const html = generateBilingualPrintableHtml(input);

    return reply
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(html);
  });

  fastify.get('/api/invoices/:id/qr', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await fetchInvoiceById(id);

    if (!row || !row.qr_code_payload) {
      return reply.status(404).send({ error: `Invoice QR not found: ${id}` });
    }

    const authCheck = checkInvoiceTenantAuth(request, row.merchant_id);
    if (!authCheck.allowed) {
      return reply.status(authCheck.status).send({
        error: authCheck.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
        message: authCheck.error
      });
    }

    try {
      const isDraftB2b = String(row.invoice_type) === 'tax_invoice' && String(row.status) !== 'cleared';
      const pngBuffer = await QRCode.toBuffer(row.qr_code_payload, {
        width: 320,
        margin: 1,
        color: { dark: isDraftB2b ? '#b91c1c' : '#000000', light: isDraftB2b ? '#fff1f2' : '#ffffff' }
      });

      reply
        .status(200)
        .header('Content-Type', 'image/png')
        .header('Cache-Control', isDraftB2b ? 'no-cache' : 'public, max-age=86400');

      if (isDraftB2b) {
        reply.header('X-Zatca-Status', 'DRAFT_AWAITING_CLEARANCE');
        reply.header('X-Zatca-Warning', 'B2B Standard Tax Invoice is awaiting ZATCA clearance; QR code cannot legally be issued to buyer yet');
      }

      return reply.send(pngBuffer);
    } catch (err: any) {
      return reply.status(500).send({ error: 'QR_GENERATION_FAILED', message: err.message });
    }
  });
}
