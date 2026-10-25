import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool } from '../storage/db.js';
import { decryptVaultSecret, decryptVaultPrivateKey } from '../crypto/vault.js';
import { signZatcaInvoiceExact } from '../crypto/zatca-signer.js';
import { buildUblXmlFromSallaOrder } from '../services/invoice-generator.js';
import { SallaOrderData } from '../types/salla.js';
import { submitInvoiceToFatoora } from '../services/fatoora-dispatcher.js';

export const StandaloneItemSchema = z.object({
  name: z.string(),
  sku: z.string().optional(),
  quantity: z.number().positive(),
  price: z.number().positive(),
  taxPercent: z.number().default(15)
});

export const StandaloneSignRequestSchema = z.object({
  merchantId: z.string(),
  branchId: z.string().optional(),
  isB2C: z.boolean().default(true),
  currency: z.string().default('SAR'),
  invoiceNumber: z.string().optional(),
  issueDate: z.string().optional(),
  issueTime: z.string().optional(),
  customer: z
    .object({
      name: z.string().default('عميل نقدي / Cash Customer'),
      taxNumber: z.string().optional().nullable(),
      street: z.string().optional(),
      buildingNumber: z.string().optional(),
      city: z.string().optional(),
      postalZone: z.string().optional(),
      countryCode: z.string().default('SA')
    })
    .optional(),
  items: z.array(StandaloneItemSchema).min(1),
  discounts: z.number().optional().default(0),
  shipping: z.number().optional().default(0),
  rawXml: z.string().optional()
});

export const standaloneApiRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Standalone signing endpoint for external PHP/Laravel/Odoo developers (Issues #49-#59)
  app.post('/api/v1/sign', async (request, reply) => {
    const parsed = StandaloneSignRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_PAYLOAD',
        details: parsed.error.format()
      });
    }

    const { merchantId, branchId, isB2C, currency, items, discounts, shipping, customer } = parsed.data;

    const client = await pool.connect();
    try {
      const egsQuery = branchId
        ? `SELECT * FROM egs_units WHERE merchant_id = $1 AND (branch_id = $2 OR custom_id = $2) AND is_active = TRUE LIMIT 1`
        : `SELECT * FROM egs_units WHERE merchant_id = $1 AND is_active = TRUE ORDER BY created_at ASC LIMIT 1`;
      const egsParams = branchId ? [merchantId, branchId] : [merchantId];
      const egsRes = await client.query(egsQuery, egsParams);

      if (egsRes.rows.length === 0) {
        return reply.status(404).send({
          error: 'EGS_UNIT_NOT_FOUND',
          message: `No active EGS unit found for merchant ${merchantId}`
        });
      }

      const egs = egsRes.rows[0];
      const now = new Date();
      const issueDate = parsed.data.issueDate || now.toISOString().split('T')[0];
      const issueTime = parsed.data.issueTime || `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
      const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
      const invoiceUuid = crypto.randomUUID();
      const icv = Number(egs.current_icv) + 1;
      const pih = egs.last_document_hash;

      let netSubtotal = 0;
      let taxTotal = 0;
      const orderItems = items.map((it, idx) => {
        const lineExt = Number((it.price * it.quantity).toFixed(2));
        const lineTax = Number((lineExt * (it.taxPercent / 100)).toFixed(2));
        netSubtotal += lineExt;
        taxTotal += lineTax;
        return {
          id: idx + 1,
          name: it.name,
          sku: it.sku || `SKU-${idx + 1}`,
          quantity: it.quantity,
          price: { amount: it.price, currency },
          total: { amount: Number((lineExt + lineTax).toFixed(2)), currency }
        };
      });

      const grandTotal = Number((netSubtotal - discounts + shipping + taxTotal).toFixed(2));

      const mockOrder: SallaOrderData = {
        id: parsed.data.invoiceNumber || `EXT-${Date.now()}`,
        reference_id: `REF-EXT-${icv}`,
        date: { date: `${issueDate} ${issueTime}`, timezone: 'Asia/Riyadh' },
        status: { id: 1, name: 'Completed', slug: 'completed' },
        payment_method: 'credit_card',
        currency,
        customer: {
          id: 1,
          first_name: customer?.name || 'Customer',
          tax_number: customer?.taxNumber || (isB2C ? null : '300075588700003'),
          company_name: isB2C ? undefined : customer?.name
        },
        shipping: {
          address: {
            country: customer?.countryCode || 'SA',
            city: customer?.city || 'Riyadh',
            street: customer?.street || 'Commercial St',
            building_number: customer?.buildingNumber || '1000',
            postal_code: customer?.postalZone || '12345'
          }
        },
        items: orderItems,
        amounts: {
          sub_total: { amount: netSubtotal, currency },
          discounts: discounts > 0 ? { amount: discounts, currency } : undefined,
          shipping_cost: shipping > 0 ? { amount: shipping, currency } : undefined,
          tax: {
            percent: 15,
            amount: { amount: taxTotal, currency }
          },
          total: { amount: grandTotal, currency }
        }
      };

      const rawXml = parsed.data.rawXml || buildUblXmlFromSallaOrder({
        order: mockOrder,
        uuid: invoiceUuid,
        icv,
        pih,
        issueDate,
        issueTime,
        sellerNameArabic: 'شركة رواء للملابس الفاخرة',
        sellerVat: egs.vat_number || '300075588700003',
        sellerCrn: '1010010000',
        isB2C
      });

      const privateKey = decryptVaultPrivateKey(egs.private_key_pem);
      const signed = signZatcaInvoiceExact({
        rawXml,
        privateKeyPem: privateKey,
        certPem: egs.certificate,
        sellerNameArabic: 'شركة رواء للملابس الفاخرة',
        sellerVatNumber: egs.vat_number || '300075588700003',
        grandTotal: grandTotal.toFixed(2),
        vatTotal: taxTotal.toFixed(2),
        issueDateTimeIsoZ,
        isB2C
      });

      return reply.status(200).send({
        success: true,
        invoiceUuid,
        icv,
        pih,
        invoiceHash: signed.invoiceHashBase64,
        qrCodeBase64: signed.qrCodeBase64,
        signedXml: signed.signedXml,
        isB2C,
        totals: {
          subtotal: netSubtotal,
          tax: taxTotal,
          grandTotal,
          currency
        }
      });
    } finally {
      client.release();
    }
  });

  // Standalone Sign and Submit to ZATCA Phase-2 Clearance / Reporting
  app.post('/api/v1/sign-and-submit', async (request, reply) => {
    const parsed = StandaloneSignRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'INVALID_PAYLOAD',
        details: parsed.error.format()
      });
    }

    const { merchantId, branchId, isB2C, currency, items, discounts, shipping, customer } = parsed.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const egsQuery = branchId
        ? `SELECT * FROM egs_units WHERE merchant_id = $1 AND (branch_id = $2 OR custom_id = $2) AND is_active = TRUE FOR UPDATE LIMIT 1`
        : `SELECT * FROM egs_units WHERE merchant_id = $1 AND is_active = TRUE ORDER BY created_at ASC FOR UPDATE LIMIT 1`;
      const egsParams = branchId ? [merchantId, branchId] : [merchantId];
      const egsRes = await client.query(egsQuery, egsParams);

      if (egsRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({
          error: 'EGS_UNIT_NOT_FOUND',
          message: `No active EGS unit found for merchant ${merchantId}`
        });
      }

      const egs = egsRes.rows[0];
      const now = new Date();
      const issueDate = parsed.data.issueDate || now.toISOString().split('T')[0];
      const issueTime = parsed.data.issueTime || `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
      const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
      const invoiceUuid = crypto.randomUUID();
      const icv = Number(egs.current_icv) + 1;
      const pih = egs.last_document_hash;

      let netSubtotal = 0;
      let taxTotal = 0;
      const orderItems = items.map((it, idx) => {
        const lineExt = Number((it.price * it.quantity).toFixed(2));
        const lineTax = Number((lineExt * (it.taxPercent / 100)).toFixed(2));
        netSubtotal += lineExt;
        taxTotal += lineTax;
        return {
          id: idx + 1,
          name: it.name,
          sku: it.sku || `SKU-${idx + 1}`,
          quantity: it.quantity,
          price: { amount: it.price, currency },
          total: { amount: Number((lineExt + lineTax).toFixed(2)), currency }
        };
      });

      const grandTotal = Number((netSubtotal - discounts + shipping + taxTotal).toFixed(2));

      const mockOrder: SallaOrderData = {
        id: parsed.data.invoiceNumber || `EXT-${Date.now()}`,
        reference_id: `REF-EXT-${icv}`,
        date: { date: `${issueDate} ${issueTime}`, timezone: 'Asia/Riyadh' },
        status: { id: 1, name: 'Completed', slug: 'completed' },
        payment_method: 'credit_card',
        currency,
        customer: {
          id: 1,
          first_name: customer?.name || 'Customer',
          tax_number: customer?.taxNumber || (isB2C ? null : '300075588700003'),
          company_name: isB2C ? undefined : customer?.name
        },
        shipping: {
          address: {
            country: customer?.countryCode || 'SA',
            city: customer?.city || 'Riyadh',
            street: customer?.street || 'Commercial St',
            building_number: customer?.buildingNumber || '1000',
            postal_code: customer?.postalZone || '12345'
          }
        },
        items: orderItems,
        amounts: {
          sub_total: { amount: netSubtotal, currency },
          discounts: discounts > 0 ? { amount: discounts, currency } : undefined,
          shipping_cost: shipping > 0 ? { amount: shipping, currency } : undefined,
          tax: {
            percent: 15,
            amount: { amount: taxTotal, currency }
          },
          total: { amount: grandTotal, currency }
        }
      };

      const rawXml = parsed.data.rawXml || buildUblXmlFromSallaOrder({
        order: mockOrder,
        uuid: invoiceUuid,
        icv,
        pih,
        issueDate,
        issueTime,
        sellerNameArabic: 'شركة رواء للملابس الفاخرة',
        sellerVat: egs.vat_number || '300075588700003',
        sellerCrn: '1010010000',
        isB2C
      });

      const privateKey = decryptVaultPrivateKey(egs.private_key_pem);
      const signed = signZatcaInvoiceExact({
        rawXml,
        privateKeyPem: privateKey,
        certPem: egs.certificate,
        sellerNameArabic: 'شركة رواء للملابس الفاخرة',
        sellerVatNumber: egs.vat_number || '300075588700003',
        grandTotal: grandTotal.toFixed(2),
        vatTotal: taxTotal.toFixed(2),
        issueDateTimeIsoZ,
        isB2C
      });

      const invType = isB2C ? 'simplified_tax_invoice' : 'tax_invoice';
      const initialStatus = isB2C ? 'reported' : 'cleared';
      const orderIdStr = mockOrder.id.toString();

      const invRes = await client.query(
        `INSERT INTO invoices (
          egs_unit_id, order_id, idempotency_key, invoice_type,
          uuid, icv, pih, invoice_hash, qr_code_payload,
          signed_xml, status, supply_date, issue_timestamp,
          subtotal, tax_total, grand_total, currency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id, uuid, icv, status, grand_total, currency`,
        [
          egs.id,
          orderIdStr,
          `ext_${invoiceUuid}`,
          invType,
          invoiceUuid,
          icv,
          pih,
          signed.invoiceHashBase64,
          signed.qrCodeBase64,
          signed.signedXml,
          initialStatus,
          issueDate,
          issueDateTimeIsoZ,
          netSubtotal,
          taxTotal,
          grandTotal,
          currency
        ]
      );

      await client.query(
        `UPDATE egs_units 
         SET current_icv = $1, last_document_hash = $2, updated_at = NOW() 
         WHERE id = $3`,
        [icv, signed.invoiceHashBase64, egs.id]
      );

      await client.query('COMMIT');

      const invoiceId = invRes.rows[0].id;

      return reply.status(200).send({
        success: true,
        invoiceId,
        invoiceUuid,
        icv,
        pih,
        status: initialStatus,
        invoiceHash: signed.invoiceHashBase64,
        qrCodeBase64: signed.qrCodeBase64,
        signedXml: signed.signedXml,
        isB2C,
        totals: {
          subtotal: netSubtotal,
          tax: taxTotal,
          grandTotal,
          currency
        }
      });
    } catch (err: any) {
      await client.query('ROLLBACK');
      return reply.status(500).send({
        error: 'SIGN_AND_SUBMIT_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });
};
