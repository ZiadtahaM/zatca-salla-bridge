import { PoolClient } from 'pg';
import { SallaOrderData, SallaOrderItem } from '../types/salla.js';
import { signZatcaInvoiceExact, SignOutput } from '../crypto/zatca-signer.js';
import { decryptVaultSecret, decryptVaultPrivateKey } from '../crypto/vault.js';

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

export function isB2bCustomer(taxNumber?: string | null, crn?: string | null): boolean {
  if (taxNumber && /^[3][0-9]{13}[3]$/.test(taxNumber.trim())) return true;
  if (crn && /^\d{10}$/.test(crn.trim())) return true;
  return false;
}

export interface B2bAddressValidation {
  isValid: boolean;
  missingFields: string[];
}

export function isExportCustomer(countryCode?: string | null): boolean {
  if (!countryCode) return false;
  const clean = countryCode.trim().toUpperCase();
  return clean !== 'SA' && clean.length === 2;
}

export function validateB2bBuyerAddress(order: SallaOrderData): B2bAddressValidation {
  const missingFields: string[] = [];
  const country = ((order.shipping?.address as any)?.country_code?.trim() || order.shipping?.address?.country || 'SA').toUpperCase();
  const isDomestic = country === 'SA';

  const taxNum = order.customer.tax_number?.trim();
  const crn = (order.customer as any)?.crn?.toString().trim();
  if (isDomestic) {
    const isValidVat = Boolean(taxNum && /^[3][0-9]{13}[3]$/.test(taxNum));
    const isValidCrn = Boolean(crn && /^\d{10}$/.test(crn));
    if (!isValidVat && !isValidCrn) {
      missingFields.push('buyer_tax_number_invalid');
    }
  } else {
    const hasId = Boolean(taxNum || (order.customer as any).id || (order.customer as any).national_id || (order.customer as any).crn);
    if (!hasId) {
      missingFields.push('foreign_buyer_id_missing');
    }
  }

  const addr = order.shipping?.address;
  if (isDomestic) {
    if (!addr?.building_number || !/^\d{4}$/.test(addr.building_number.trim())) {
      missingFields.push('building_number_4_digits');
    }
    if (!addr?.postal_code || !/^\d{5}$/.test(addr.postal_code.trim())) {
      missingFields.push('postal_code_5_digits');
    }
    if (!addr?.district || addr.district.trim().length === 0) {
      missingFields.push('district_subdivision');
    }
  }

  if (!addr?.street || addr.street.trim().length === 0) {
    missingFields.push('street_name');
  }
  if (!addr?.city || addr.city.trim().length === 0) {
    missingFields.push('city_name');
  }

  return {
    isValid: missingFields.length === 0,
    missingFields
  };
}

export interface HalalaReconciledLine {
  id: number;
  name: string;
  quantity: number;
  unitPrice: number;
  lineExtension: number;
  taxAmount: number;
  taxPercent: number;
  taxCategory: string;
  exemptionXml: string;
  grossAmount: number;
}

export interface HalalaReconciliationResult {
  isVatInclusivePrices: boolean;
  driftHalalas: number;
  lineExtensionTotal: number;
  allowanceTotal: number;
  chargeTotal: number;
  taxExclusiveAmount: number;
  taxTotalAmount: number;
  grandTotal: number;
  reconciledLines: HalalaReconciledLine[];
}

export function reconcileHalalaRounding(
  order: SallaOrderData,
  isExport: boolean = false,
  docCurrency: string = 'SAR'
): HalalaReconciliationResult {
  const discountAmount = order.amounts.discounts?.amount || 0;
  const shippingAmount = order.amounts.shipping_cost?.amount || 0;
  const codAmount = order.amounts.cash_on_delivery?.amount || 0;
  const chargeAmount = shippingAmount + codAmount;

  let rawItemsSum = 0;
  for (const it of order.items) {
    rawItemsSum += it.price.amount * it.quantity;
  }

  const sallaTotal = order.amounts.total.amount;
  const sallaSubtotal = order.amounts.sub_total.amount;
  const sallaTax = order.amounts.tax.amount.amount;

  const isVatInclusivePrices =
    (order as any).prices_include_tax === true ||
    (order as any).price_includes_tax === true ||
    (Math.abs(rawItemsSum - sallaTotal) < 0.05 && sallaTax > 0) ||
    (Math.abs(rawItemsSum - (sallaTotal - chargeAmount + discountAmount)) < 0.05 && sallaTax > 0);

  let calculatedTaxTotal = 0;
  let calculatedLineExtensionTotal = 0;
  const lines: HalalaReconciledLine[] = [];

  for (let i = 0; i < order.items.length; i++) {
    const item = order.items[i];
    const lineNum = i + 1;

    const isGiftVoucher =
      (item as any).is_voucher === true ||
      (item as any).type === 'voucher_multi_purpose' ||
      (item.name &&
        (item.name.includes('كوبون') ||
          item.name.includes('قسيمة') ||
          item.name.toLowerCase().includes('voucher') ||
          item.name.toLowerCase().includes('gift card')));

    let lineTaxCategory = 'S';
    let lineTaxPercent = 15.0;
    let exemptionXml = '';

    if (isGiftVoucher) {
      lineTaxCategory = 'O';
      lineTaxPercent = 0.0;
      exemptionXml = `\n        <cbc:TaxExemptionReasonCode>VATEX-SA-OOS</cbc:TaxExemptionReasonCode>\n        <cbc:TaxExemptionReason>Not subject to VAT - Multi-purpose voucher</cbc:TaxExemptionReason>`;
    } else if (isExport) {
      lineTaxCategory = 'Z';
      lineTaxPercent = 0.0;
      exemptionXml = `\n        <cbc:TaxExemptionReasonCode>VATEX-SA-32</cbc:TaxExemptionReasonCode>\n        <cbc:TaxExemptionReason>Export of goods outside GCC</cbc:TaxExemptionReason>`;
    }

    let unitPrice = item.price.amount;
    if (isVatInclusivePrices && !isGiftVoucher && !isExport) {
      unitPrice = Number((item.price.amount / 1.15).toFixed(4));
    }

    const lineExtension = isVatInclusivePrices
      ? Number((unitPrice * item.quantity).toFixed(2))
      : Number((item.price.amount * item.quantity).toFixed(2));

    const lineTaxAmount =
      lineTaxCategory === 'S' ? Number((lineExtension * (lineTaxPercent / 100)).toFixed(2)) : 0;
    const lineGross = Number((lineExtension + lineTaxAmount).toFixed(2));

    calculatedLineExtensionTotal += lineExtension;
    calculatedTaxTotal += lineTaxAmount;

    lines.push({
      id: lineNum,
      name: item.name.trim().normalize('NFC'),
      quantity: item.quantity,
      unitPrice,
      lineExtension,
      taxAmount: lineTaxAmount,
      taxPercent: lineTaxPercent,
      taxCategory: lineTaxCategory,
      exemptionXml,
      grossAmount: lineGross
    });
  }

  let lineExtTotal = isVatInclusivePrices
    ? Number(calculatedLineExtensionTotal.toFixed(2))
    : sallaSubtotal;
  let taxExclusive = Number((lineExtTotal - discountAmount + chargeAmount).toFixed(2));
  let finalTax = Number(calculatedTaxTotal.toFixed(2));
  if (!isExport && !isVatInclusivePrices && sallaTax > 0) {
    finalTax = sallaTax;
  }

  let finalGrandTotal = Number((taxExclusive + finalTax).toFixed(2));
  const drift = Number((sallaTotal - finalGrandTotal).toFixed(2));

  if (Math.abs(drift) > 0 && Math.abs(drift) <= 0.05) {
    const lastTaxableLine = [...lines].reverse().find(l => l.taxCategory === 'S');
    if (lastTaxableLine) {
      lastTaxableLine.taxAmount = Number((lastTaxableLine.taxAmount + drift).toFixed(2));
      lastTaxableLine.grossAmount = Number((lastTaxableLine.lineExtension + lastTaxableLine.taxAmount).toFixed(2));
      finalTax = Number((finalTax + drift).toFixed(2));
      finalGrandTotal = Number((taxExclusive + finalTax).toFixed(2));
    }
  }

  return {
    isVatInclusivePrices,
    driftHalalas: Math.round(drift * 100),
    lineExtensionTotal: lineExtTotal,
    allowanceTotal: discountAmount,
    chargeTotal: chargeAmount,
    taxExclusiveAmount: taxExclusive,
    taxTotalAmount: finalTax,
    grandTotal: finalGrandTotal,
    reconciledLines: lines
  };
}

export interface BuildUblXmlOptions {
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
  currency?: string;
  exchangeRateToSar?: number;
  isExport?: boolean;
  foreignBuyerCountry?: string;
  foreignBuyerId?: string;
  foreignBuyerScheme?: string;
  prepaidAmount?: number;
  advanceInvoiceUuid?: string;
  advanceInvoiceId?: string;
  isAdvanceInvoice?: boolean;
}

export function buildUblXmlFromSallaOrder(options: BuildUblXmlOptions): string {
  const invoiceTypeCodeName = options.isB2C ? '0200000' : '0100000';
  const docCurrency = options.currency || options.order.currency || (options.order as any).total?.currency || 'SAR';
  const isForeignCurrency = docCurrency !== 'SAR';
  const exchangeRateToSar = options.exchangeRateToSar || (docCurrency === 'USD' ? 3.75 : 1.0);
  
  const buyerCountry = options.foreignBuyerCountry || (options.order.shipping?.address as any)?.country_code || (options.order.shipping?.address as any)?.country || 'SA';
  const isExport = options.isExport || (buyerCountry.toUpperCase() !== 'SA');

  let customerPartyBlock = '';
  if (options.isB2C) {
    customerPartyBlock = `  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cac:Country>
          <cbc:IdentificationCode>${buyerCountry.toUpperCase()}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>`;
  } else if (isExport) {
    const foreignId = options.foreignBuyerId || options.order.customer.tax_number || (options.order.customer as any).id || 'EXPORT-BUYER-01';
    const scheme = options.foreignBuyerScheme || 'OTH';
    customerPartyBlock = `  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="${scheme}">${foreignId}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${options.order.shipping?.address?.street || 'Export Street'}</cbc:StreetName>
        <cbc:CityName>${options.order.shipping?.address?.city || 'Dubai'}</cbc:CityName>
        <cac:Country>
          <cbc:IdentificationCode>${buyerCountry.toUpperCase()}</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${(options.order.customer.company_name || `${options.order.customer.first_name} ${options.order.customer.last_name || ''}`).trim().normalize('NFC')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;
  } else {
    customerPartyBlock = `  <cac:AccountingCustomerParty>
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
  }

  const reconciliation = reconcileHalalaRounding(options.order, isExport, docCurrency);
  const discountAmount = reconciliation.allowanceTotal;
  const chargeTotal = reconciliation.chargeTotal;
  const lineExtensionTotal = reconciliation.lineExtensionTotal;
  const allowanceTotal = reconciliation.allowanceTotal;
  const taxExclusiveAmount = reconciliation.taxExclusiveAmount;
  let declaredTaxTotal = reconciliation.taxTotalAmount;
  const grandTotal = reconciliation.grandTotal;
  const prepaidAmount = options.prepaidAmount || 0;
  const payableAmount = Number((grandTotal - prepaidAmount).toFixed(2));
  const hasGiftVoucher = reconciliation.reconciledLines.some(l => l.taxCategory === 'O');

  let allowanceChargeXml = '';
  if (allowanceTotal > 0) {
    allowanceChargeXml += `  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Discount / تخفيض ترويجي</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="${docCurrency}">${allowanceTotal.toFixed(2)}</cbc:Amount>
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
    <cbc:Amount currencyID="${docCurrency}">${chargeTotal.toFixed(2)}</cbc:Amount>
    <cac:TaxCategory>
      <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">S</cbc:ID>
      <cbc:Percent>15.00</cbc:Percent>
      <cac:TaxScheme>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
      </cac:TaxScheme>
    </cac:TaxCategory>
  </cac:AllowanceCharge>\n`;
  }

  const linesXml = reconciliation.reconciledLines
    .map(line => {
      const formattedUnitPrice = (line.lineExtension / line.quantity).toFixed(2);
      return `  <cac:InvoiceLine>
    <cbc:ID>${line.id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${line.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${docCurrency}">${line.lineExtension.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${docCurrency}">${line.taxAmount.toFixed(2)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${docCurrency}">${line.grossAmount.toFixed(2)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${line.name}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${line.taxCategory}</cbc:ID>
        <cbc:Percent>${line.taxPercent.toFixed(2)}</cbc:Percent>${line.exemptionXml}
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${docCurrency}">${formattedUnitPrice}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join('\n');

  let advanceReferenceXml = '';
  if (options.advanceInvoiceId || options.advanceInvoiceUuid) {
    advanceReferenceXml = `  <cac:AdditionalDocumentReference>
    <cbc:ID>${options.advanceInvoiceId || 'PREPAY-01'}</cbc:ID>
    <cbc:UUID>${options.advanceInvoiceUuid || '00000000-0000-0000-0000-000000000000'}</cbc:UUID>
    <cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>
  </cac:AdditionalDocumentReference>\n`;
  }

  const invoiceTypeCodeNumber = options.isAdvanceInvoice ? '386' : '388';

  let taxCategoryHeader = 'S';
  let taxPercentHeader = 15.00;
  let taxExemptionHeaderXml = '';
  if (isExport) {
    taxCategoryHeader = 'Z';
    taxPercentHeader = 0.00;
    taxExemptionHeaderXml = `\n        <cbc:TaxExemptionReasonCode>VATEX-SA-32</cbc:TaxExemptionReasonCode>\n        <cbc:TaxExemptionReason>Export of goods outside GCC</cbc:TaxExemptionReason>`;
  } else if (hasGiftVoucher && declaredTaxTotal === 0) {
    taxCategoryHeader = 'O';
    taxPercentHeader = 0.00;
    taxExemptionHeaderXml = `\n        <cbc:TaxExemptionReasonCode>VATEX-SA-OOS</cbc:TaxExemptionReasonCode>\n        <cbc:TaxExemptionReason>Not subject to VAT - Multi-purpose voucher</cbc:TaxExemptionReason>`;
  }

  let rootTaxTotalsXml = '';
  if (isForeignCurrency) {
    const taxInSar = Number((declaredTaxTotal * exchangeRateToSar).toFixed(2));
    rootTaxTotalsXml = `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${taxInSar.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${docCurrency}">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${docCurrency}">${taxExclusiveAmount.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${docCurrency}">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${taxCategoryHeader}</cbc:ID>
        <cbc:Percent>${taxPercentHeader.toFixed(2)}</cbc:Percent>${taxExemptionHeaderXml}
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>`;
  } else {
    rootTaxTotalsXml = `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${taxExclusiveAmount.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${taxCategoryHeader}</cbc:ID>
        <cbc:Percent>${taxPercentHeader.toFixed(2)}</cbc:Percent>${taxExemptionHeaderXml}
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-${options.icv}</cbc:ID>
  <cbc:UUID>${options.uuid}</cbc:UUID>
  <cbc:IssueDate>${options.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${options.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${invoiceTypeCodeName}">${invoiceTypeCodeNumber}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${docCurrency}</cbc:DocumentCurrencyCode>
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
${advanceReferenceXml}  <cac:AccountingSupplierParty>
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
${allowanceChargeXml}${rootTaxTotalsXml}
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${docCurrency}">${lineExtensionTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${docCurrency}">${taxExclusiveAmount.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${docCurrency}">${grandTotal.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="${docCurrency}">${allowanceTotal.toFixed(2)}</cbc:AllowanceTotalAmount>
    <cbc:ChargeTotalAmount currencyID="${docCurrency}">${chargeTotal.toFixed(2)}</cbc:ChargeTotalAmount>
    <cbc:PrepaidAmount currencyID="${docCurrency}">${prepaidAmount.toFixed(2)}</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="${docCurrency}">${payableAmount.toFixed(2)}</cbc:PayableAmount>
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

    const privateKey = decryptVaultPrivateKey(egs.private_key_pem);

    const signed: SignOutput = signZatcaInvoiceExact({
      rawXml,
      privateKeyPem: privateKey,
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

    const privateKey = decryptVaultPrivateKey(egs.private_key_pem);

    const signed = signZatcaInvoiceExact({
      rawXml: rawCreditNoteXml,
      privateKeyPem: privateKey,
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

export interface ProcessPartialCreditNoteOptions {
  originalInvoiceId: string;
  refundAmount: number;
  returnReason?: string;
  items?: Array<{ name: string; quantity: number; price: number }>;
  idempotencyKey?: string;
}

export async function processPartialCreditNote(
  client: PoolClient,
  egsUnitId: string,
  options: ProcessPartialCreditNoteOptions
): Promise<GeneratedInvoiceResult> {
  const returnReason = options.returnReason || 'Partial customer refund';
  const now = new Date();
  const issueDate = now.toISOString().split('T')[0];
  const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
  const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
  const creditNoteUuid = crypto.randomUUID();

  await client.query('BEGIN');

  try {
    const origRes = await client.query(
      `SELECT id, uuid, icv, status, grand_total, currency, invoice_type, order_id 
       FROM invoices 
       WHERE id = $1 OR uuid = $1
       LIMIT 1`,
      [options.originalInvoiceId]
    );

    if (origRes.rows.length === 0) {
      throw new Error(`Original invoice ${options.originalInvoiceId} not found`);
    }

    const originalInvoice = origRes.rows[0];
    const origGrandTotal = Number(originalInvoice.grand_total);

    if (options.refundAmount <= 0) {
      throw new Error('Refund amount must be strictly positive');
    }
    if (options.refundAmount > origGrandTotal) {
      throw new Error(`Partial refund amount (${options.refundAmount}) cannot exceed original invoice total (${origGrandTotal})`);
    }

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
    const isB2C = originalInvoice.invoice_type === 'simplified_tax_invoice';

    const netRefund = Number((options.refundAmount / 1.15).toFixed(2));
    const vatRefund = Number((options.refundAmount - netRefund).toFixed(2));

    const refundOrder: SallaOrderData = {
      id: originalInvoice.order_id || `CN-${Date.now()}`,
      reference_id: `REF-CN-${nextIcv}`,
      date: { date: `${issueDate} ${issueTime}`, timezone: 'Asia/Riyadh' },
      status: { id: 1, name: 'Refunded', slug: 'refunded' },
      payment_method: 'credit_card',
      currency: originalInvoice.currency || 'SAR',
      customer: {
        id: 1,
        first_name: 'Customer',
        tax_number: isB2C ? null : '300075588700003'
      },
      items: options.items && options.items.length > 0
        ? options.items.map((it, idx) => ({
            id: idx + 1,
            name: it.name,
            quantity: it.quantity,
            price: { amount: it.price, currency: originalInvoice.currency || 'SAR' },
            total: { amount: Number((it.price * it.quantity).toFixed(2)), currency: originalInvoice.currency || 'SAR' }
          }))
        : [
            {
              id: 1,
              name: `استرجاع جزئي / Partial Return: ${returnReason}`,
              quantity: 1,
              price: { amount: netRefund, currency: originalInvoice.currency || 'SAR' },
              total: { amount: options.refundAmount, currency: originalInvoice.currency || 'SAR' }
            }
          ],
      amounts: {
        sub_total: { amount: netRefund, currency: originalInvoice.currency || 'SAR' },
        tax: {
          percent: 15,
          amount: { amount: vatRefund, currency: originalInvoice.currency || 'SAR' }
        },
        total: { amount: options.refundAmount, currency: originalInvoice.currency || 'SAR' }
      }
    };

    const rawCreditNoteXml = buildUblCreditNoteXmlFromSallaRefund({
      order: refundOrder,
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

    const privateKey = decryptVaultPrivateKey(egs.private_key_pem);
    const signed = signZatcaInvoiceExact({
      rawXml: rawCreditNoteXml,
      privateKeyPem: privateKey,
      certPem: egs.certificate,
      sellerNameArabic: 'شركة رواء للملابس الفاخرة',
      sellerVatNumber: '300075588700003',
      grandTotal: options.refundAmount.toFixed(2),
      vatTotal: vatRefund.toFixed(2),
      issueDateTimeIsoZ,
      isB2C
    });

    const idempotency = options.idempotencyKey || `cn_part_${originalInvoice.id}_${Date.now()}`;

    const cnRes = await client.query(
      `INSERT INTO invoices (
        egs_unit_id,
        order_id,
        idempotency_key,
        invoice_type,
        uuid,
        icv,
        pih,
        invoice_hash,
        qr_code_payload,
        signed_xml,
        status,
        supply_date,
        issue_timestamp,
        replaces_invoice_id,
        subtotal,
        tax_total,
        grand_total,
        currency
      ) VALUES ($1, $2, $3, 'credit_note', $4, $5, $6, $7, $8, $9, 'reported', $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, uuid, icv, status, grand_total, currency`,
      [
        egs.id,
        originalInvoice.order_id,
        idempotency,
        creditNoteUuid,
        nextIcv,
        currentPih,
        signed.invoiceHashBase64,
        signed.qrCodeBase64,
        signed.signedXml,
        issueDate,
        issueDateTimeIsoZ,
        originalInvoice.id,
        netRefund,
        vatRefund,
        options.refundAmount,
        originalInvoice.currency || 'SAR'
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
