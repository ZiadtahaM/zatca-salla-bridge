import { PoolClient } from 'pg';
import { SallaOrderData, SallaOrderItem } from '../types/salla.js';
import { signZatcaInvoiceExact, SignOutput } from '../crypto/zatca-signer.js';
import { decryptVaultSecret } from '../crypto/vault.js';

export interface GeneratedInvoiceResult {
  invoiceId: string;
  invoiceUuid: string;
  icv: number;
  pih: string;
  invoiceHash: string;
  qrCodeBase64: string;
  signedXml: string;
  isB2C: boolean;
}

export function formatZatcaUtcZTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yyyy = date.getUTCFullYear();
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const min = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());

  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`;
}

export function isB2bCustomer(taxNumber?: string | null): boolean {
  if (!taxNumber) return false;
  const clean = taxNumber.trim();
  return /^[3][0-9]{13}[3]$/.test(clean);
}

export function buildUblXmlFromSallaOrder(options: {
  order: SallaOrderData;
  uuid: string;
  icv: number;
  pih: string;
  issueDate: string;
  issueTime: string;
  sellerNameArabic: string;
  sellerVat: string;
  sellerCrn: string;
  isB2C: boolean;
}): string {
  const invoiceTypeCodeName = options.isB2C ? '0200000' : '0100000';
  const customerPartyBlock = options.isB2C
    ? `  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>`
    : `  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">7000000001</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${options.order.shipping?.address?.street || 'Commercial Street'}</cbc:StreetName>
        <cbc:BuildingNumber>${options.order.shipping?.address?.building_number || '1000'}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${options.order.shipping?.address?.district || 'District'}</cbc:CitySubdivisionName>
        <cbc:CityName>${options.order.shipping?.address?.city || 'Riyadh'}</cbc:CityName>
        <cbc:PostalZone>${options.order.shipping?.address?.postal_code || '12345'}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${options.order.customer.tax_number?.trim()}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${(options.order.customer.company_name || `${options.order.customer.first_name} ${options.order.customer.last_name || ''}`).trim().normalize('NFC')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;

  const subtotal = options.order.amounts.sub_total.amount.toFixed(2);
  const taxTotal = options.order.amounts.tax.amount.amount.toFixed(2);
  const grandTotal = options.order.amounts.total.amount.toFixed(2);

  const linesXml = options.order.items
    .map((item: SallaOrderItem, index: number) => {
      const lineNum = index + 1;
      const itemPrice = item.price.amount.toFixed(2);
      const lineExtension = (item.price.amount * item.quantity).toFixed(2);
      const lineTax = (item.price.amount * item.quantity * 0.15).toFixed(2);
      const lineGross = (Number(lineExtension) + Number(lineTax)).toFixed(2);
      const itemName = item.name.trim().normalize('NFC');

      return `  <cac:InvoiceLine>
    <cbc:ID>${lineNum}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${item.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${lineExtension}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${lineTax}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="SAR">${lineGross}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${itemName}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">${itemPrice}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-${options.icv}</cbc:ID>
  <cbc:UUID>${options.uuid}</cbc:UUID>
  <cbc:IssueDate>${options.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${options.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${invoiceTypeCodeName}">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${options.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cac:EmbeddedDocumentBinaryObject mimeCode="text/plain">${options.pih}</cac:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${options.sellerCrn}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>King Fahd Road</cbc:StreetName>
        <cbc:BuildingNumber>1234</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>Al-Olaya</cbc:CitySubdivisionName>
        <cbc:CityName>Riyadh</cbc:CityName>
        <cbc:PostalZone>12211</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${options.sellerVat}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${options.sellerNameArabic.normalize('NFC')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
${customerPartyBlock}
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${taxTotal}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${taxTotal}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${subtotal}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${taxTotal}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${subtotal}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${subtotal}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${grandTotal}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">0.00</cbc:AllowanceTotalAmount>
    <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="SAR">${grandTotal}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${linesXml}
</Invoice>`;
}

export function buildUblCreditNoteXmlFromSallaRefund(options: {
  order: SallaOrderData;
  originalInvoiceUuid: string;
  originalIcv: number;
  returnReason: string;
  uuid: string;
  icv: number;
  pih: string;
  issueDate: string;
  issueTime: string;
  sellerNameArabic: string;
  sellerVat: string;
  sellerCrn: string;
  isB2C: boolean;
}): string {
  const invoiceTypeCodeName = options.isB2C ? '0200000' : '0100000';
  const customerPartyBlock = options.isB2C
    ? `  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>`
    : `  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">7000000001</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${options.order.shipping?.address?.street || 'Commercial Street'}</cbc:StreetName>
        <cbc:BuildingNumber>${options.order.shipping?.address?.building_number || '1000'}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${options.order.shipping?.address?.district || 'District'}</cbc:CitySubdivisionName>
        <cbc:CityName>${options.order.shipping?.address?.city || 'Riyadh'}</cbc:CityName>
        <cbc:PostalZone>${options.order.shipping?.address?.postal_code || '12345'}</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${options.order.customer.tax_number?.trim()}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${(options.order.customer.company_name || `${options.order.customer.first_name} ${options.order.customer.last_name || ''}`).trim().normalize('NFC')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;

  const subtotal = options.order.amounts.sub_total.amount.toFixed(2);
  const taxTotal = options.order.amounts.tax.amount.amount.toFixed(2);
  const grandTotal = options.order.amounts.total.amount.toFixed(2);

  const linesXml = options.order.items
    .map((item: SallaOrderItem, index: number) => {
      const lineNum = index + 1;
      const itemPrice = item.price.amount.toFixed(2);
      const lineExtension = (item.price.amount * item.quantity).toFixed(2);
      const lineTax = (item.price.amount * item.quantity * 0.15).toFixed(2);
      const lineGross = (Number(lineExtension) + Number(lineTax)).toFixed(2);
      const itemName = item.name.trim().normalize('NFC');

      return `  <cac:InvoiceLine>
    <cbc:ID>${lineNum}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${item.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${lineExtension}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${lineTax}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="SAR">${lineGross}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${itemName}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="SAR">${itemPrice}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>CN-${options.icv}</cbc:ID>
  <cbc:UUID>${options.uuid}</cbc:UUID>
  <cbc:IssueDate>${options.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${options.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${invoiceTypeCodeName}">381</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${options.originalInvoiceUuid}</cbc:ID>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${options.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cac:EmbeddedDocumentBinaryObject mimeCode="text/plain">${options.pih}</cac:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${options.sellerCrn}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>King Fahd Road</cbc:StreetName>
        <cbc:BuildingNumber>1234</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>Al-Olaya</cbc:CitySubdivisionName>
        <cbc:CityName>Riyadh</cbc:CityName>
        <cbc:PostalZone>12211</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>SA</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${options.sellerVat}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${options.sellerNameArabic.normalize('NFC')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
${customerPartyBlock}
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>10</cbc:PaymentMeansCode>
    <cbc:InstructionNote>${options.returnReason.normalize('NFC')}</cbc:InstructionNote>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${taxTotal}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${taxTotal}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${subtotal}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${taxTotal}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${subtotal}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${subtotal}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${grandTotal}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">0.00</cbc:AllowanceTotalAmount>
    <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="SAR">${grandTotal}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${linesXml}
</Invoice>`;
}

export async function processSallaOrderIntoZatcaInvoice(
  client: PoolClient,
  egsUnitId: string,
  order: SallaOrderData,
  idempotencyKey: string
): Promise<GeneratedInvoiceResult> {
  const isB2C = !isB2bCustomer(order.customer.tax_number);
  const now = new Date();
  const issueDate = now.toISOString().split('T')[0];
  const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
  const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
  const invoiceUuid = crypto.randomUUID();

  await client.query('BEGIN');

  try {
    const egsRes = await client.query(
      `SELECT id, merchant_id, current_icv, last_document_hash, 
              private_key_pem, certificate, expires_at, csid_environment
       FROM egs_units 
       WHERE id = $1 FOR UPDATE`,
      [egsUnitId]
    );

    if (egsRes.rows.length === 0) {
      throw new Error(`EGS Unit ${egsUnitId} not found`);
    }

    const egs = egsRes.rows[0];

    if (new Date(egs.expires_at) <= new Date()) {
      throw new Error(`EGS Unit ${egsUnitId} certificate expired on ${egs.expires_at}`);
    }

    const nextIcv = Number(egs.current_icv) + 1;
    const currentPih = egs.last_document_hash;

    const rawXml = buildUblXmlFromSallaOrder({
      order,
      uuid: invoiceUuid,
      icv: nextIcv,
      pih: currentPih,
      issueDate,
      issueTime,
      sellerNameArabic: 'شركة رواء للملابس الفاخرة',
      sellerVat: '300075588700003',
      sellerCrn: '1010010000',
      isB2C
    });

    const privateKeyPem = egs.private_key_pem.startsWith('v1:')
      ? decryptVaultSecret(egs.private_key_pem)
      : egs.private_key_pem;

    const signed: SignOutput = signZatcaInvoiceExact({
      rawXml,
      privateKeyPem,
      certPem: egs.certificate,
      sellerNameArabic: 'شركة رواء للملابس الفاخرة',
      sellerVatNumber: '300075588700003',
      grandTotal: order.amounts.total.amount.toFixed(2),
      vatTotal: order.amounts.tax.amount.amount.toFixed(2),
      issueDateTimeIsoZ,
      isB2C
    });

    const invoiceRes = await client.query(
      `INSERT INTO invoices (
        egs_unit_id, order_id, idempotency_key, invoice_type, uuid,
        icv, pih, invoice_hash, qr_code_payload, signed_xml,
        status, supply_date, issue_timestamp, subtotal, tax_total, grand_total
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        'signed', $11, $12, $13, $14, $15
      ) RETURNING id`,
      [
        egs.id,
        order.id.toString(),
        idempotencyKey,
        isB2C ? 'simplified_tax_invoice' : 'tax_invoice',
        invoiceUuid,
        nextIcv,
        currentPih,
        signed.invoiceHashBase64,
        signed.qrCodeBase64,
        signed.signedXml,
        issueDate,
        issueDateTimeIsoZ,
        order.amounts.sub_total.amount,
        order.amounts.tax.amount.amount,
        order.amounts.total.amount
      ]
    );

    await client.query(
      `UPDATE egs_units 
       SET current_icv = $1, 
           last_document_hash = $2, 
           updated_at = NOW() 
       WHERE id = $3`,
      [nextIcv, signed.invoiceHashBase64, egs.id]
    );

    await client.query('COMMIT');

    return {
      invoiceId: invoiceRes.rows[0].id,
      invoiceUuid,
      icv: nextIcv,
      pih: currentPih,
      invoiceHash: signed.invoiceHashBase64,
      qrCodeBase64: signed.qrCodeBase64,
      signedXml: signed.signedXml,
      isB2C
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export async function processSallaRefundIntoZatcaCreditNote(
  client: PoolClient,
  egsUnitId: string,
  order: SallaOrderData,
  idempotencyKey: string,
  returnReason: string = 'Customer return or order refund'
): Promise<GeneratedInvoiceResult> {
  const isB2C = !isB2bCustomer(order.customer.tax_number);
  const now = new Date();
  const issueDate = now.toISOString().split('T')[0];
  const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
  const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
  const creditNoteUuid = crypto.randomUUID();

  await client.query('BEGIN');

  try {
    const origRes = await client.query(
      `SELECT id, uuid, icv, status 
       FROM invoices 
       WHERE order_id = $1 AND invoice_type IN ('simplified_tax_invoice', 'tax_invoice')
       ORDER BY created_at DESC LIMIT 1`,
      [order.id.toString()]
    );

    if (origRes.rows.length === 0) {
      throw new Error(`Cannot issue credit note: No original invoice found for Salla order ${order.id}`);
    }

    const originalInvoice = origRes.rows[0];

    const egsRes = await client.query(
      `SELECT id, merchant_id, current_icv, last_document_hash, 
              private_key_pem, certificate, expires_at, csid_environment
       FROM egs_units 
       WHERE id = $1 FOR UPDATE`,
      [egsUnitId]
    );

    if (egsRes.rows.length === 0) {
      throw new Error(`EGS Unit ${egsUnitId} not found`);
    }

    const egs = egsRes.rows[0];
    const nextIcv = Number(egs.current_icv) + 1;
    const currentPih = egs.last_document_hash;

    const rawCreditNoteXml = buildUblCreditNoteXmlFromSallaRefund({
      order,
      originalInvoiceUuid: originalInvoice.uuid,
      originalIcv: Number(originalInvoice.icv),
      returnReason,
      uuid: creditNoteUuid,
      icv: nextIcv,
      pih: currentPih,
      issueDate,
      issueTime,
      sellerNameArabic: 'شركة رواء للملابس الفاخرة',
      sellerVat: '300075588700003',
      sellerCrn: '1010010000',
      isB2C
    });

    const privateKeyPem = egs.private_key_pem.startsWith('v1:')
      ? decryptVaultSecret(egs.private_key_pem)
      : egs.private_key_pem;

    const signed = signZatcaInvoiceExact({
      rawXml: rawCreditNoteXml,
      privateKeyPem,
      certPem: egs.certificate,
      sellerNameArabic: 'شركة رواء للملابس الفاخرة',
      sellerVatNumber: '300075588700003',
      grandTotal: order.amounts.total.amount.toFixed(2),
      vatTotal: order.amounts.tax.amount.amount.toFixed(2),
      issueDateTimeIsoZ,
      isB2C
    });

    const cnRes = await client.query(
      `INSERT INTO invoices (
        egs_unit_id, order_id, idempotency_key, invoice_type, uuid,
        icv, pih, invoice_hash, qr_code_payload, signed_xml,
        status, supply_date, issue_timestamp, replaces_invoice_id,
        subtotal, tax_total, grand_total
      ) VALUES (
        $1, $2, $3, 'credit_note', $4,
        $5, $6, $7, $8, $9,
        'signed', $10, $11, $12, $13, $14, $15
      ) RETURNING id`,
      [
        egs.id,
        order.id.toString(),
        idempotencyKey,
        creditNoteUuid,
        nextIcv,
        currentPih,
        signed.invoiceHashBase64,
        signed.qrCodeBase64,
        signed.signedXml,
        issueDate,
        issueDateTimeIsoZ,
        originalInvoice.id,
        order.amounts.sub_total.amount,
        order.amounts.tax.amount.amount,
        order.amounts.total.amount
      ]
    );

    await client.query(
      `UPDATE egs_units 
       SET current_icv = $1, 
           last_document_hash = $2, 
           updated_at = NOW() 
       WHERE id = $3`,
      [nextIcv, signed.invoiceHashBase64, egs.id]
    );

    await client.query('COMMIT');

    return {
      invoiceId: cnRes.rows[0].id,
      invoiceUuid: creditNoteUuid,
      icv: nextIcv,
      pih: currentPih,
      invoiceHash: signed.invoiceHashBase64,
      qrCodeBase64: signed.qrCodeBase64,
      signedXml: signed.signedXml,
      isB2C
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
