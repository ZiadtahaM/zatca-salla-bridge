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

export interface B2bAddressValidation {
  isValid: boolean;
  missingFields: string[];
}

export function validateB2bBuyerAddress(order: SallaOrderData): B2bAddressValidation {
  const missingFields: string[] = [];
  const taxNum = order.customer.tax_number?.trim();
  if (!taxNum || !/^[3][0-9]{13}[3]$/.test(taxNum)) {
    missingFields.push('buyer_tax_number_invalid');
  }

  const addr = order.shipping?.address;
  if (!addr?.building_number || !/^\d{4}$/.test(addr.building_number.trim())) {
    missingFields.push('building_number_4_digits');
  }
  if (!addr?.postal_code || !/^\d{5}$/.test(addr.postal_code.trim())) {
    missingFields.push('postal_code_5_digits');
  }
  if (!addr?.street || addr.street.trim().length === 0) {
    missingFields.push('street_name');
  }
  if (!addr?.district || addr.district.trim().length === 0) {
    missingFields.push('district_subdivision');
  }
  if (!addr?.city || addr.city.trim().length === 0) {
    missingFields.push('city_name');
  }

  return {
    isValid: missingFields.length === 0,
    missingFields
  };
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

  const discountAmount = options.order.amounts.discounts?.amount || 0;
  const shippingAmount = options.order.amounts.shipping_cost?.amount || 0;
  const codAmount = options.order.amounts.cash_on_delivery?.amount || 0;
  const chargeAmount = shippingAmount + codAmount;

  const lineExtensionTotal = options.order.amounts.sub_total.amount;
  const allowanceTotal = discountAmount;
  const chargeTotal = chargeAmount;
  const taxExclusiveAmount = Number((lineExtensionTotal - allowanceTotal + chargeTotal).toFixed(2));
  const declaredTaxTotal = options.order.amounts.tax.amount.amount;
  const grandTotal = Number((taxExclusiveAmount + declaredTaxTotal).toFixed(2));

  let allowanceChargeXml = '';
  if (allowanceTotal > 0) {
    allowanceChargeXml += `  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Discount / تخفيض ترويجي</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="SAR">${allowanceTotal.toFixed(2)}</cbc:Amount>
    <cac:TaxCategory>
      <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
      <cbc:Percent>15.00</cbc:Percent>
      <cac:TaxScheme>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
      </cac:TaxScheme>
    </cac:TaxCategory>
  </cac:AllowanceCharge>\n`;
  }

  if (chargeTotal > 0) {
    allowanceChargeXml += `  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>true</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Shipping and Handling / رسوم الشحن والتوصيل</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="SAR">${chargeTotal.toFixed(2)}</cbc:Amount>
    <cac:TaxCategory>
      <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
      <cbc:Percent>15.00</cbc:Percent>
      <cac:TaxScheme>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
      </cac:TaxScheme>
    </cac:TaxCategory>
  </cac:AllowanceCharge>\n`;
  }

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
${allowanceChargeXml}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${taxExclusiveAmount.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
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
    <cbc:LineExtensionAmount currencyID="SAR">${lineExtensionTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${taxExclusiveAmount.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${grandTotal.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">${allowanceTotal.toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:ChargeTotalAmount currencyID="SAR">${chargeTotal.toFixed(2)}</cbc:ChargeTotalAmount>
    <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="SAR">${grandTotal.toFixed(2)}</cbc:PayableAmount>
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

  const discountAmount = options.order.amounts.discounts?.amount || 0;
  const shippingAmount = options.order.amounts.shipping_cost?.amount || 0;
  const codAmount = options.order.amounts.cash_on_delivery?.amount || 0;
  const chargeAmount = shippingAmount + codAmount;

  const lineExtensionTotal = options.order.amounts.sub_total.amount;
  const allowanceTotal = discountAmount;
  const chargeTotal = chargeAmount;
  const taxExclusiveAmount = Number((lineExtensionTotal - allowanceTotal + chargeTotal).toFixed(2));
  const declaredTaxTotal = options.order.amounts.tax.amount.amount;
  const grandTotal = Number((taxExclusiveAmount + declaredTaxTotal).toFixed(2));

  let allowanceChargeXml = '';
  if (allowanceTotal > 0) {
    allowanceChargeXml += `  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Discount / تخفيض ترويجي</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="SAR">${allowanceTotal.toFixed(2)}</cbc:Amount>
    <cac:TaxCategory>
      <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
      <cbc:Percent>15.00</cbc:Percent>
      <cac:TaxScheme>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
      </cac:TaxScheme>
    </cac:TaxCategory>
  </cac:AllowanceCharge>\n`;
  }

  if (chargeTotal > 0) {
    allowanceChargeXml += `  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>true</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Shipping and Handling / رسوم الشحن والتوصيل</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="SAR">${chargeTotal.toFixed(2)}</cbc:Amount>
    <cac:TaxCategory>
      <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
      <cbc:Percent>15.00</cbc:Percent>
      <cac:TaxScheme>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
      </cac:TaxScheme>
    </cac:TaxCategory>
  </cac:AllowanceCharge>\n`;
  }

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
${allowanceChargeXml}  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${taxExclusiveAmount.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
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
    <cbc:LineExtensionAmount currencyID="SAR">${lineExtensionTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${taxExclusiveAmount.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${grandTotal.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">${allowanceTotal.toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:ChargeTotalAmount currencyID="SAR">${chargeTotal.toFixed(2)}</cbc:ChargeTotalAmount>
    <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="SAR">${grandTotal.toFixed(2)}</cbc:PayableAmount>
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
              private_key_pem, csid_secret, certificate, expires_at, csid_environment
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

    const discountAmount = order.amounts.discounts?.amount || 0;
    const shippingAmount = order.amounts.shipping_cost?.amount || 0;
    const codAmount = order.amounts.cash_on_delivery?.amount || 0;
    const chargeAmount = shippingAmount + codAmount;

    const lineExtensionTotal = order.amounts.sub_total.amount;
    const allowanceTotal = discountAmount;
    const chargeTotal = chargeAmount;
    const taxExclusiveAmount = Number((lineExtensionTotal - allowanceTotal + chargeTotal).toFixed(2));
    const declaredTaxTotal = order.amounts.tax.amount.amount;
    const grandTotal = Number((taxExclusiveAmount + declaredTaxTotal).toFixed(2));

    const privateKeyPem = decryptVaultSecret(egs.private_key_pem);

    const signed: SignOutput = signZatcaInvoiceExact({
      rawXml,
      privateKeyPem,
      certPem: egs.certificate,
      sellerNameArabic: 'شركة رواء للملابس الفاخرة',
      sellerVatNumber: '300075588700003',
      grandTotal: grandTotal.toFixed(2),
      vatTotal: declaredTaxTotal.toFixed(2),
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
        lineExtensionTotal,
        declaredTaxTotal,
        grandTotal
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
              private_key_pem, csid_secret, certificate, expires_at, csid_environment
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

    const discountAmount = order.amounts.discounts?.amount || 0;
    const shippingAmount = order.amounts.shipping_cost?.amount || 0;
    const codAmount = order.amounts.cash_on_delivery?.amount || 0;
    const chargeAmount = shippingAmount + codAmount;

    const lineExtensionTotal = order.amounts.sub_total.amount;
    const allowanceTotal = discountAmount;
    const chargeTotal = chargeAmount;
    const taxExclusiveAmount = Number((lineExtensionTotal - allowanceTotal + chargeTotal).toFixed(2));
    const declaredTaxTotal = order.amounts.tax.amount.amount;
    const grandTotal = Number((taxExclusiveAmount + declaredTaxTotal).toFixed(2));

    const privateKeyPem = decryptVaultSecret(egs.private_key_pem);

    const signed = signZatcaInvoiceExact({
      rawXml: rawCreditNoteXml,
      privateKeyPem,
      certPem: egs.certificate,
      sellerNameArabic: 'شركة رواء للملابس الفاخرة',
      sellerVatNumber: '300075588700003',
      grandTotal: grandTotal.toFixed(2),
      vatTotal: declaredTaxTotal.toFixed(2),
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
        lineExtensionTotal,
        declaredTaxTotal,
        grandTotal
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
