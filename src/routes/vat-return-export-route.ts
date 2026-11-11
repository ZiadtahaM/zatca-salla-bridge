import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DOMParser } from '@xmldom/xmldom';
import { pool } from '../storage/db.js';
import { authenticateMerchantRequest } from '../crypto/auth-session.js';

export async function vatReturnExportRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/invoices/export.csv', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query || {}) as {
      merchantId?: string;
      merchant?: string;
      from?: string;
      to?: string;
    };

    const merchantId = (query.merchantId || query.merchant || 'salla_demo_store').toString().trim();

    // Enforce authentication
    const auth = authenticateMerchantRequest(request, merchantId);
    if (!auth.authenticated) {
      return reply.status(auth.status).send({
        error: auth.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
        message: auth.error
      });
    }

    const client = await pool.connect();
    try {
      // Default to current quarter start if not specified
      const now = new Date();
      const currentYear = now.getUTCFullYear();
      const currentMonth = now.getUTCMonth(); // 0..11
      const quarterStartMonth = Math.floor(currentMonth / 3) * 3;
      const defaultFrom = new Date(Date.UTC(currentYear, quarterStartMonth, 1)).toISOString();
      const defaultTo = now.toISOString();

      const fromDate = query.from || defaultFrom;
      const toDate = query.to || defaultTo;

      const res = await client.query(
        `SELECT i.id, i.uuid, i.icv, i.invoice_type, i.status, i.issue_timestamp,
                i.supply_date, i.subtotal, i.tax_total, i.grand_total, i.currency,
                i.order_id, i.pih, i.invoice_hash, i.signed_xml, e.merchant_id
         FROM invoices i
         JOIN egs_units e ON e.id = i.egs_unit_id
         WHERE e.merchant_id = $1
           AND i.issue_timestamp >= $2
           AND i.issue_timestamp <= $3
         ORDER BY i.icv ASC`,
        [merchantId, fromDate, toDate]
      );

      const rows = res.rows;

      // Calculate VAT Return Summary Aggregates by statutory VAT Category (Form VAT 01)
      let box1SalesNet = 0;
      let box1SalesVat = 0;
      let box1AdjustmentsNet = 0; // Credit notes on Standard Rated supplies
      let box1AdjustmentsVat = 0;
      let box3ZeroRatedNet = 0; // Box 3: Zero-Rated Domestic Sales
      let box3AdjustmentsNet = 0;
      let box4ExportsNet = 0; // Box 4: Exports of Goods & Services
      let box4AdjustmentsNet = 0;
      let box5ExemptNet = 0; // Box 5: Exempt & Out-of-Scope Supplies
      let box5AdjustmentsNet = 0;
      let unreportedCount = 0;

      for (const row of rows) {
        const subtotal = Number(row.subtotal) || 0;
        const vat = Number(row.tax_total) || 0;
        const type = String(row.invoice_type);
        const status = String(row.status);
        const xml = String(row.signed_xml || '');

        if (status !== 'cleared' && status !== 'reported' && status !== 'reported_with_warnings' && status !== 'cleared_with_warnings') {
          unreportedCount++;
        }

        const parser = new DOMParser({
          errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} }
        });
        let doc: Document | null = null;
        if (xml) {
          try {
            doc = parser.parseFromString(xml, 'text/xml');
          } catch {
            doc = null;
          }
        }

        // Detect export supplies based on customer country outside SA
        let isExport = false;
        if (doc) {
          const customerParty = doc.getElementsByTagName('cac:AccountingCustomerParty')[0];
          if (customerParty) {
            const countryCodes = customerParty.getElementsByTagName('cbc:IdentificationCode');
            if (countryCodes.length > 0) {
              const code = countryCodes[0]?.textContent?.trim().toUpperCase();
              if (code && code !== 'SA') {
                isExport = true;
              }
            }
          }
        }

        // Extract TaxSubtotal nodes from cac:TaxTotal
        const subtotals: Array<{ category: string; taxableAmount: number; taxAmount: number }> = [];

        if (doc) {
          const taxTotals = doc.getElementsByTagName('cac:TaxTotal');
          for (let t = 0; t < taxTotals.length; t++) {
            const taxTotal = taxTotals[t];
            const taxSubtotalElements = taxTotal.getElementsByTagName('cac:TaxSubtotal');
            for (let s = 0; s < taxSubtotalElements.length; s++) {
              const subElem = taxSubtotalElements[s];
              const taxableEl = subElem.getElementsByTagName('cbc:TaxableAmount')[0];
              const taxEl = subElem.getElementsByTagName('cbc:TaxAmount')[0];
              const catEl = subElem.getElementsByTagName('cac:TaxCategory')[0]?.getElementsByTagName('cbc:ID')[0];

              const catId = catEl?.textContent?.trim().toUpperCase() || 'S';
              const taxableVal = Number(taxableEl?.textContent?.trim()) || 0;
              const taxVal = Number(taxEl?.textContent?.trim()) || 0;

              subtotals.push({
                category: catId,
                taxableAmount: taxableVal,
                taxAmount: taxVal
              });
            }
          }
        }

        if (subtotals.length > 0) {
          for (const sub of subtotals) {
            if (type === 'credit_note') {
              if (sub.category === 'S') {
                box1AdjustmentsNet += sub.taxableAmount;
                box1AdjustmentsVat += sub.taxAmount;
              } else if (sub.category === 'Z') {
                if (isExport) {
                  box4AdjustmentsNet += sub.taxableAmount;
                } else {
                  box3AdjustmentsNet += sub.taxableAmount;
                }
              } else {
                box5AdjustmentsNet += sub.taxableAmount;
              }
            } else {
              if (sub.category === 'S') {
                box1SalesNet += sub.taxableAmount;
                box1SalesVat += sub.taxAmount;
              } else if (sub.category === 'Z') {
                if (isExport) {
                  box4ExportsNet += sub.taxableAmount;
                } else {
                  box3ZeroRatedNet += sub.taxableAmount;
                }
              } else {
                box5ExemptNet += sub.taxableAmount;
              }
            }
          }
        } else {
          let fallbackCat = vat > 0 ? 'S' : 'Z';
          if (type === 'credit_note') {
            if (fallbackCat === 'S') {
              box1AdjustmentsNet += subtotal;
              box1AdjustmentsVat += vat;
            } else {
              box3AdjustmentsNet += subtotal;
            }
          } else {
            if (fallbackCat === 'S') {
              box1SalesNet += subtotal;
              box1SalesVat += vat;
            } else {
              box3ZeroRatedNet += subtotal;
            }
          }
        }
      }

      const netVatPayable = Number((box1SalesVat - box1AdjustmentsVat).toFixed(2));

      // Build CSV with UTF-8 BOM for perfect Microsoft Excel rendering in Arabic
      const csvLines: string[] = [];
      csvLines.push('\uFEFF# ملخص إقرار ضريبة القيمة المضافة لهيئة الزكاة والضريبة والجمارك (ZATCA VAT Return Form Summary - Form VAT 01)');
      csvLines.push(`# المتجر: ${merchantId}`);
      csvLines.push(`# الفترة الضريبية: من ${fromDate.slice(0, 10)} إلى ${toDate.slice(0, 10)}`);
      csvLines.push(`# تاريخ الاستخراج: ${now.toISOString()}`);
      csvLines.push('# --------------------------------------------------------------------------------');
      csvLines.push('# بند الإقرار الضريبي,المبلغ الخاضع للضريبة (SAR),مبلغ ضريبة القيمة المضافة (SAR),التعديلات والإشعارات الدائنة (SAR)');
      csvLines.push(`المبيعات الخاضعة للنسبة الأساسية (Box 1 Standard Sales / 15% Standard Rated),${box1SalesNet.toFixed(2)},${box1SalesVat.toFixed(2)},-${box1AdjustmentsNet.toFixed(2)}`);
      csvLines.push(`التعديلات والإشعارات الدائنة (Box 1 Adjustments / Credit Notes),-${box1AdjustmentsNet.toFixed(2)},-${box1AdjustmentsVat.toFixed(2)},-`);
      csvLines.push(`صافي ضريبة المبيعات المستحقة السداد (Net VAT Payable),${(box1SalesNet - box1AdjustmentsNet).toFixed(2)},${netVatPayable.toFixed(2)},-`);
      csvLines.push(`المبيعات المحلية الخاضعة للنسبة الصفرية (Box 3 Zero-Rated Domestic Sales),${box3ZeroRatedNet.toFixed(2)},0.00,-${box3AdjustmentsNet.toFixed(2)}`);
      csvLines.push(`صادرات السلع والخدمات (Box 4 Exports of Goods & Services),${box4ExportsNet.toFixed(2)},0.00,-${box4AdjustmentsNet.toFixed(2)}`);
      csvLines.push(`التوريدات المعفاة وخارج نطاق الضريبة (Box 5 Exempt & Out-of-Scope Supplies),${box5ExemptNet.toFixed(2)},0.00,-${box5AdjustmentsNet.toFixed(2)}`);
      csvLines.push(`عدد الفواتير غير المعتمدة أو المعلقة (Unreported Invoices Count),${unreportedCount},${unreportedCount === 0 ? 'مكتمل وجاهز للتقديم' : 'تنبيه: يجب اعتماد الفواتير قبل تقديم الإقرار'}`);
      csvLines.push('# --------------------------------------------------------------------------------');
      csvLines.push('');
      csvLines.push('رقم العداد (ICV),تاريخ الإصدار (Timestamp),نوع الوثيقة (Document Type),حالة الزكاة (ZATCA Status),رقم الطلب (Order ID),المبلغ قبل الضريبة (SAR),الضريبة (15% SAR),الإجمالي الشامل (SAR),المعرف الفريد (UUID)');

      for (const row of rows) {
        const typeLabel =
          row.invoice_type === 'simplified_tax_invoice'
            ? 'فاتورة ضريبية مبسطة (B2C)'
            : row.invoice_type === 'tax_invoice'
            ? 'فاتورة ضريبية قياسية (B2B)'
            : 'إشعار دائن (381 Credit Note)';

        const statusLabel =
          row.status === 'cleared'
            ? 'معتمدة (CLEARED)'
            : row.status === 'reported'
            ? 'مبلّغة (REPORTED)'
            : row.status === 'signed'
            ? 'موقعة محلياً (SIGNED)'
            : row.status;

        csvLines.push(
          [
            row.icv,
            `"${row.issue_timestamp}"`,
            `"${typeLabel}"`,
            `"${statusLabel}"`,
            `"${row.order_id}"`,
            Number(row.subtotal).toFixed(2),
            Number(row.tax_total).toFixed(2),
            Number(row.grand_total).toFixed(2),
            `"${row.uuid}"`
          ].join(',')
        );
      }

      const csvContent = csvLines.join('\r\n');
      const filename = `zatca_vat_return_${merchantId}_${now.toISOString().slice(0, 10)}.csv`;

      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(csvContent);
    } finally {
      client.release();
    }
  });
}
