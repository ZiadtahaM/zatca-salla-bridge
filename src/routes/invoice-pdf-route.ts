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
    invoiceHash: String(row.invoice_hash)
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

export async function invoicePdfRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/invoices/:id/pdf', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const row = await fetchInvoiceById(id);

    if (!row) {
      return reply.status(404).send({ error: `Invoice not found: ${id}` });
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

    try {
      const pngBuffer = await QRCode.toBuffer(row.qr_code_payload, {
        width: 320,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' }
      });

      return reply
        .status(200)
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'public, max-age=86400')
        .send(pngBuffer);
    } catch (err: any) {
      return reply.status(500).send({ error: 'QR_GENERATION_FAILED', message: err.message });
    }
  });
}
