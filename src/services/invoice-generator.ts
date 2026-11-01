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

export interface PrepaymentAdjustment {
  invoiceId: string; // BT-1: Prepayment invoice reference number / IRN
  invoiceUuid?: string;
  issueDate: string; // BT-2: Prepayment issue date (YYYY-MM-DD)
  issueTime: string; // KSA-25: Prepayment issue time (HH:MM:SSZ)
  taxableAmount: number; // KSA-31: Prepayment VAT Category Taxable Amount
  taxAmount: number; // KSA-32: Prepayment VAT Category Tax Amount
  vatCategory: string; // KSA-33: VAT Category code ('S', 'Z', 'E', 'O')
  vatRate: number; // KSA-34: Applicable prepayment VAT rate (15.00, 5.00, 0.00)
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
  advanceInvoiceIssueDate?: string;
  advanceInvoiceIssueTime?: string;
  isAdvanceInvoice?: boolean;
  prepaymentAdjustments?: PrepaymentAdjustment[];
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

  // Resolve Prepayment Adjustments per ZATCA Phase 2 (BT-113, KSA-30=386, KSA-31, KSA-32, KSA-33, KSA-34, BR-CO-16)
  const prepaymentAdjustments: PrepaymentAdjustment[] = [];
  if (options.prepaymentAdjustments && options.prepaymentAdjustments.length > 0) {
    prepaymentAdjustments.push(...options.prepaymentAdjustments);
  } else if (options.advanceInvoiceId || options.advanceInvoiceUuid || (options.prepaidAmount && options.prepaidAmount > 0)) {
    const rawPrepaid = options.prepaidAmount || 0;
    const taxable = Number((rawPrepaid / 1.15).toFixed(2));
    const tax = Number((rawPrepaid - taxable).toFixed(2));
    prepaymentAdjustments.push({
      invoiceId: options.advanceInvoiceId || 'PREPAY-01',
      invoiceUuid: options.advanceInvoiceUuid || '00000000-0000-0000-0000-000000000000',
      issueDate: options.advanceInvoiceIssueDate || options.issueDate,
      issueTime: options.advanceInvoiceIssueTime || options.issueTime,
      taxableAmount: taxable,
      taxAmount: tax,
      vatCategory: 'S',
      vatRate: 15.00
    });
  }

  const totalPrepaidAmount = prepaymentAdjustments.reduce(
    (sum, adj) => sum + Number((adj.taxableAmount + adj.taxAmount).toFixed(2)),
    0
  );
  const prepaidAmount = options.isAdvanceInvoice ? 0 : (prepaymentAdjustments.length > 0 ? Number(totalPrepaidAmount.toFixed(2)) : (options.prepaidAmount || 0));
  const payableAmount = Number(Math.max(0, grandTotal - prepaidAmount).toFixed(2));
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
  if (prepaymentAdjustments.length > 0 && !options.isAdvanceInvoice) {
    advanceReferenceXml = prepaymentAdjustments.map(adj => `  <cac:AdditionalDocumentReference>
    <cbc:ID>${adj.invoiceId}</cbc:ID>
    <cbc:UUID>${adj.invoiceUuid || '00000000-0000-0000-0000-000000000000'}</cbc:UUID>
    <cbc:IssueDate>${adj.issueDate}</cbc:IssueDate>
    <cbc:IssueTime>${adj.issueTime}</cbc:IssueTime>
    <cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>
  </cac:AdditionalDocumentReference>`).join('\n') + '\n';
  }

  let prepaymentLinesXml = '';
  if (prepaymentAdjustments.length > 0 && !options.isAdvanceInvoice) {
    let nextLineId = reconciliation.reconciledLines.length + 1;
    prepaymentLinesXml = '\n' + prepaymentAdjustments.map((adj) => {
      const lineId = nextLineId++;
      return `  <cac:InvoiceLine>
    <cbc:ID>${lineId}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">1.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${docCurrency}">0.00</cbc:LineExtensionAmount>
    <cac:DocumentReference>
      <cbc:ID>${adj.invoiceId}</cbc:ID>
      <cbc:IssueDate>${adj.issueDate}</cbc:IssueDate>
      <cbc:IssueTime>${adj.issueTime}</cbc:IssueTime>
      <cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>
    </cac:DocumentReference>
    <cac:Item>
      <cbc:Name>Prepayment Adjustment / تسوية دفعة مقدمة - ${adj.invoiceId}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">${adj.vatCategory}</cbc:ID>
        <cbc:Percent>${adj.vatRate.toFixed(2)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5153">VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${docCurrency}">0.00</cbc:PriceAmount>
    </cac:Price>
    <ext:UBLExtensions>
      <ext:UBLExtension>
        <ext:ExtensionContent>
          <UBLPrepaymentExtension xmlns="urn:zatca:names:specification:ubl:ext:prepayment">
            <KSA-31 currencyID="${docCurrency}">${adj.taxableAmount.toFixed(2)}</KSA-31>
            <KSA-32 currencyID="${docCurrency}">${adj.taxAmount.toFixed(2)}</KSA-32>
            <KSA-33>${adj.vatCategory}</KSA-33>
            <KSA-34>${adj.vatRate.toFixed(2)}</KSA-34>
          </UBLPrepaymentExtension>
        </ext:ExtensionContent>
      </ext:UBLExtension>
    </ext:UBLExtensions>
  </cac:InvoiceLine>`;
    }).join('\n');
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
${linesXml}${prepaymentLinesXml}
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

export function buildUblDebitNoteXml(options: {
  order: SallaOrderData;
  originalInvoiceUuid: string;
  originalIcv: number;
  debitReason: string;
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
        <cbc:CompanyID>${options.order.customer.tax_number?.trim() || '300000000000003'}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${(options.order.customer.company_name || `${options.order.customer.first_name} ${options.order.customer.last_name || ''}`).trim().normalize('NFC')}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>`;

  const lineExtensionTotal = options.order.amounts.sub_total.amount;
  const declaredTaxTotal = options.order.amounts.tax.amount.amount;
  const grandTotal = Number((lineExtensionTotal + declaredTaxTotal).toFixed(2));

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
  <cbc:ID>DN-${options.icv}</cbc:ID>
  <cbc:UUID>${options.uuid}</cbc:UUID>
  <cbc:IssueDate>${options.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${options.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${invoiceTypeCodeName}">383</cbc:InvoiceTypeCode>
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
    <cbc:InstructionNote>${options.debitReason.normalize('NFC')}</cbc:InstructionNote>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${declaredTaxTotal.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${lineExtensionTotal.toFixed(2)}</cbc:TaxableAmount>
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
    <cbc:TaxExclusiveAmount currencyID="SAR">${lineExtensionTotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${grandTotal.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">0.00</cbc:AllowanceTotalAmount>
    <cbc:ChargeTotalAmount currencyID="SAR">0.00</cbc:ChargeTotalAmount>
    <cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>
    <cbc:PayableAmount currencyID="SAR">${grandTotal.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${linesXml}
</Invoice>`;
}

export interface ComplianceSignedDocument {
  name: string;
  typeCode: string;
  subtype: string;
  isB2B: boolean;
  isB2C?: boolean;
  uuid: string;
  icv: number;
  pih: string;
  invoiceHash: string;
  signedXml: string;
  payload: {
    invoiceHash: string;
    uuid: string;
    invoice: string;
  };
}

export function generateComplianceDocumentSet(options: {
  sellerNameArabic: string;
  sellerVat: string;
  sellerCrn: string;
  privateKeyPem: string;
  certPem: string;
}): ComplianceSignedDocument[] {
  const now = new Date();
  const issueDate = now.toISOString().split('T')[0];
  const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
  const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;

  const sampleB2bOrder: SallaOrderData = {
    id: `COMPL-ORD-B2B-${Date.now()}`,
    reference_id: `REF-B2B-${Date.now()}`,
    date: { date: `${issueDate} ${issueTime}`, timezone: 'Asia/Riyadh' },
    status: { id: 1, name: 'Delivered', slug: 'delivered' },
    payment_method: 'bank_transfer',
    currency: 'SAR',
    customer: {
      id: 501,
      first_name: 'شركة',
      last_name: 'التقنية المتقدمة',
      company_name: 'شركة التقنية المتقدمة للتجارة',
      tax_number: '300000000000003'
    },
    shipping: {
      address: {
        street: 'King Fahd Road',
        building_number: '1234',
        district: 'Al-Olaya',
        city: 'Riyadh',
        postal_code: '12211',
        country: 'SA'
      }
    },
    items: [
      {
        id: 1,
        name: 'جهاز خادم شبكات متقدم / Enterprise Network Appliance',
        quantity: 1,
        price: { amount: 1000.0, currency: 'SAR' },
        total: { amount: 1000.0, currency: 'SAR' }
      }
    ],
    amounts: {
      sub_total: { amount: 1000.0, currency: 'SAR' },
      tax: {
        percent: 15,
        amount: { amount: 150.0, currency: 'SAR' }
      },
      total: { amount: 1150.0, currency: 'SAR' }
    }
  };

  const sampleB2cOrder: SallaOrderData = {
    id: `COMPL-ORD-B2C-${Date.now()}`,
    reference_id: `REF-B2C-${Date.now()}`,
    date: { date: `${issueDate} ${issueTime}`, timezone: 'Asia/Riyadh' },
    status: { id: 1, name: 'Delivered', slug: 'delivered' },
    payment_method: 'credit_card',
    currency: 'SAR',
    customer: {
      id: 502,
      first_name: 'أحمد',
      last_name: 'الغامدي',
      tax_number: null
    },
    shipping: {
      address: {
        street: 'Tahlia Street',
        city: 'Jeddah',
        country: 'SA'
      }
    },
    items: [
      {
        id: 1,
        name: 'عطر العود الملكي / Royal Oud Perfume',
        quantity: 1,
        price: { amount: 200.0, currency: 'SAR' },
        total: { amount: 200.0, currency: 'SAR' }
      }
    ],
    amounts: {
      sub_total: { amount: 200.0, currency: 'SAR' },
      tax: {
        percent: 15,
        amount: { amount: 30.0, currency: 'SAR' }
      },
      total: { amount: 230.0, currency: 'SAR' }
    }
  };

  const docs: ComplianceSignedDocument[] = [];
  let currentPih = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU4ZjgyYTgwMjdhMDY1ZDE4MGNkNGI3Nzg4MzBkNWU1NTc1OWQ2ODU5Nw==';

  // 1. Standard B2B Invoice (388)
  const b2bInvUuid = crypto.randomUUID();
  const b2bInvRaw = buildUblXmlFromSallaOrder({
    order: sampleB2bOrder,
    uuid: b2bInvUuid,
    icv: 1,
    pih: currentPih,
    issueDate,
    issueTime,
    sellerNameArabic: options.sellerNameArabic,
    sellerVat: options.sellerVat,
    sellerCrn: options.sellerCrn,
    isB2C: false
  });
  const b2bInvSigned = signZatcaInvoiceExact({
    rawXml: b2bInvRaw,
    privateKeyPem: options.privateKeyPem,
    certPem: options.certPem,
    sellerNameArabic: options.sellerNameArabic,
    sellerVatNumber: options.sellerVat,
    grandTotal: '1150.00',
    vatTotal: '150.00',
    issueDateTimeIsoZ,
    isB2C: false
  });
  docs.push({
    name: 'Standard B2B Tax Invoice',
    typeCode: '388',
    subtype: '0100000',
    isB2B: true,
    uuid: b2bInvUuid,
    icv: 1,
    pih: currentPih,
    invoiceHash: b2bInvSigned.invoiceHashBase64,
    signedXml: b2bInvSigned.signedXml,
    payload: {
      invoiceHash: b2bInvSigned.invoiceHashBase64,
      uuid: b2bInvUuid,
      invoice: Buffer.from(b2bInvSigned.signedXml, 'utf8').toString('base64')
    }
  });
  currentPih = b2bInvSigned.invoiceHashBase64;

  // 2. Standard B2B Credit Note (381)
  const b2bCnUuid = crypto.randomUUID();
  const b2bCnRaw = buildUblCreditNoteXmlFromSallaRefund({
    order: sampleB2bOrder,
    originalInvoiceUuid: b2bInvUuid,
    originalIcv: 1,
    returnReason: 'Return of defective hardware / إرجاع عتاد معيب',
    uuid: b2bCnUuid,
    icv: 2,
    pih: currentPih,
    issueDate,
    issueTime,
    sellerNameArabic: options.sellerNameArabic,
    sellerVat: options.sellerVat,
    sellerCrn: options.sellerCrn,
    isB2C: false
  });
  const b2bCnSigned = signZatcaInvoiceExact({
    rawXml: b2bCnRaw,
    privateKeyPem: options.privateKeyPem,
    certPem: options.certPem,
    sellerNameArabic: options.sellerNameArabic,
    sellerVatNumber: options.sellerVat,
    grandTotal: '1150.00',
    vatTotal: '150.00',
    issueDateTimeIsoZ,
    isB2C: false
  });
  docs.push({
    name: 'Standard B2B Credit Note',
    typeCode: '381',
    subtype: '0100000',
    isB2B: true,
    uuid: b2bCnUuid,
    icv: 2,
    pih: currentPih,
    invoiceHash: b2bCnSigned.invoiceHashBase64,
    signedXml: b2bCnSigned.signedXml,
    payload: {
      invoiceHash: b2bCnSigned.invoiceHashBase64,
      uuid: b2bCnUuid,
      invoice: Buffer.from(b2bCnSigned.signedXml, 'utf8').toString('base64')
    }
  });
  currentPih = b2bCnSigned.invoiceHashBase64;

  // 3. Standard B2B Debit Note (383)
  const b2bDnUuid = crypto.randomUUID();
  const b2bDnRaw = buildUblDebitNoteXml({
    order: sampleB2bOrder,
    originalInvoiceUuid: b2bInvUuid,
    originalIcv: 1,
    debitReason: 'Price adjustment for extra maintenance / تعديل رسوم صيانة إضافية',
    uuid: b2bDnUuid,
    icv: 3,
    pih: currentPih,
    issueDate,
    issueTime,
    sellerNameArabic: options.sellerNameArabic,
    sellerVat: options.sellerVat,
    sellerCrn: options.sellerCrn,
    isB2C: false
  });
  const b2bDnSigned = signZatcaInvoiceExact({
    rawXml: b2bDnRaw,
    privateKeyPem: options.privateKeyPem,
    certPem: options.certPem,
    sellerNameArabic: options.sellerNameArabic,
    sellerVatNumber: options.sellerVat,
    grandTotal: '1150.00',
    vatTotal: '150.00',
    issueDateTimeIsoZ,
    isB2C: false
  });
  docs.push({
    name: 'Standard B2B Debit Note',
    typeCode: '383',
    subtype: '0100000',
    isB2B: true,
    uuid: b2bDnUuid,
    icv: 3,
    pih: currentPih,
    invoiceHash: b2bDnSigned.invoiceHashBase64,
    signedXml: b2bDnSigned.signedXml,
    payload: {
      invoiceHash: b2bDnSigned.invoiceHashBase64,
      uuid: b2bDnUuid,
      invoice: Buffer.from(b2bDnSigned.signedXml, 'utf8').toString('base64')
    }
  });
  currentPih = b2bDnSigned.invoiceHashBase64;

  // 4. Simplified B2C Invoice (388)
  const b2cInvUuid = crypto.randomUUID();
  const b2cInvRaw = buildUblXmlFromSallaOrder({
    order: sampleB2cOrder,
    uuid: b2cInvUuid,
    icv: 4,
    pih: currentPih,
    issueDate,
    issueTime,
    sellerNameArabic: options.sellerNameArabic,
    sellerVat: options.sellerVat,
    sellerCrn: options.sellerCrn,
    isB2C: true
  });
  const b2cInvSigned = signZatcaInvoiceExact({
    rawXml: b2cInvRaw,
    privateKeyPem: options.privateKeyPem,
    certPem: options.certPem,
    sellerNameArabic: options.sellerNameArabic,
    sellerVatNumber: options.sellerVat,
    grandTotal: '230.00',
    vatTotal: '30.00',
    issueDateTimeIsoZ,
    isB2C: true
  });
  docs.push({
    name: 'Simplified B2C Tax Invoice',
    typeCode: '388',
    subtype: '0200000',
    isB2C: true,
    isB2B: false,
    uuid: b2cInvUuid,
    icv: 4,
    pih: currentPih,
    invoiceHash: b2cInvSigned.invoiceHashBase64,
    signedXml: b2cInvSigned.signedXml,
    payload: {
      invoiceHash: b2cInvSigned.invoiceHashBase64,
      uuid: b2cInvUuid,
      invoice: Buffer.from(b2cInvSigned.signedXml, 'utf8').toString('base64')
    }
  });
  currentPih = b2cInvSigned.invoiceHashBase64;

  // 5. Simplified B2C Credit Note (381)
  const b2cCnUuid = crypto.randomUUID();
  const b2cCnRaw = buildUblCreditNoteXmlFromSallaRefund({
    order: sampleB2cOrder,
    originalInvoiceUuid: b2cInvUuid,
    originalIcv: 4,
    returnReason: 'Order cancelled before shipment / إلغاء طلب قبل الشحن',
    uuid: b2cCnUuid,
    icv: 5,
    pih: currentPih,
    issueDate,
    issueTime,
    sellerNameArabic: options.sellerNameArabic,
    sellerVat: options.sellerVat,
    sellerCrn: options.sellerCrn,
    isB2C: true
  });
  const b2cCnSigned = signZatcaInvoiceExact({
    rawXml: b2cCnRaw,
    privateKeyPem: options.privateKeyPem,
    certPem: options.certPem,
    sellerNameArabic: options.sellerNameArabic,
    sellerVatNumber: options.sellerVat,
    grandTotal: '230.00',
    vatTotal: '30.00',
    issueDateTimeIsoZ,
    isB2C: true
  });
  docs.push({
    name: 'Simplified B2C Credit Note',
    typeCode: '381',
    subtype: '0200000',
    isB2C: true,
    isB2B: false,
    uuid: b2cCnUuid,
    icv: 5,
    pih: currentPih,
    invoiceHash: b2cCnSigned.invoiceHashBase64,
    signedXml: b2cCnSigned.signedXml,
    payload: {
      invoiceHash: b2cCnSigned.invoiceHashBase64,
      uuid: b2cCnUuid,
      invoice: Buffer.from(b2cCnSigned.signedXml, 'utf8').toString('base64')
    }
  });
  currentPih = b2cCnSigned.invoiceHashBase64;

  // 6. Simplified B2C Debit Note (383)
  const b2cDnUuid = crypto.randomUUID();
  const b2cDnRaw = buildUblDebitNoteXml({
    order: sampleB2cOrder,
    originalInvoiceUuid: b2cInvUuid,
    originalIcv: 4,
    debitReason: 'Additional delivery charges / رسوم توصيل إضافية',
    uuid: b2cDnUuid,
    icv: 6,
    pih: currentPih,
    issueDate,
    issueTime,
    sellerNameArabic: options.sellerNameArabic,
    sellerVat: options.sellerVat,
    sellerCrn: options.sellerCrn,
    isB2C: true
  });
  const b2cDnSigned = signZatcaInvoiceExact({
    rawXml: b2cDnRaw,
    privateKeyPem: options.privateKeyPem,
    certPem: options.certPem,
    sellerNameArabic: options.sellerNameArabic,
    sellerVatNumber: options.sellerVat,
    grandTotal: '230.00',
    vatTotal: '30.00',
    issueDateTimeIsoZ,
    isB2C: true
  });
  docs.push({
    name: 'Simplified B2C Debit Note',
    typeCode: '383',
    subtype: '0200000',
    isB2C: true,
    isB2B: false,
    uuid: b2cDnUuid,
    icv: 6,
    pih: currentPih,
    invoiceHash: b2cDnSigned.invoiceHashBase64,
    signedXml: b2cDnSigned.signedXml,
    payload: {
      invoiceHash: b2cDnSigned.invoiceHashBase64,
      uuid: b2cDnUuid,
      invoice: Buffer.from(b2cDnSigned.signedXml, 'utf8').toString('base64')
    }
  });

  return docs;
}


const egsMutexMap = new Map<string, Promise<any>>();

export async function withEgsMutex<T>(egsUnitId: string, fn: () => Promise<T>): Promise<T> {
  while (egsMutexMap.has(egsUnitId)) {
    try {
      await egsMutexMap.get(egsUnitId);
    } catch {
      // previous invocation completed, continue chain
    }
  }

  let resolveMutex: () => void;
  const mutexPromise = new Promise<void>((resolve) => {
    resolveMutex = resolve;
  });
  egsMutexMap.set(egsUnitId, mutexPromise);

  try {
    return await fn();
  } finally {
    if (egsMutexMap.get(egsUnitId) === mutexPromise) {
      egsMutexMap.delete(egsUnitId);
    }
    resolveMutex!();
  }
}

export interface ProcessInvoiceOverrides {
  sellerNameArabic?: string;
  sellerVat?: string;
  sellerCrn?: string;
}

export async function processSallaOrderIntoZatcaInvoice(
  client: PoolClient,
  egsUnitId: string,
  order: SallaOrderData,
  idempotencyKey: string,
  overrides?: ProcessInvoiceOverrides
): Promise<GeneratedInvoiceResult> {
  return withEgsMutex(egsUnitId, async () => {
    const isB2C = !isB2bCustomer(order.customer?.tax_number);
    const now = new Date();
    const issueDate = now.toISOString().split('T')[0];
    const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
    const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
    const invoiceUuid = crypto.randomUUID();

    await client.query('BEGIN');

    try {
      if (idempotencyKey) {
        const existingRes = await client.query(
          `SELECT id, uuid, icv, pih, invoice_hash, qr_code_payload, signed_xml, invoice_type
           FROM invoices 
           WHERE idempotency_key = $1`,
          [idempotencyKey]
        );
        if (existingRes.rows.length > 0) {
          const row = existingRes.rows[0];
          await client.query('ROLLBACK');
          return {
            invoiceId: row.id,
            invoiceUuid: row.uuid,
            icv: Number(row.icv),
            pih: row.pih,
            invoiceHash: row.invoice_hash,
            qrCodeBase64: row.qr_code_payload,
            signedXml: row.signed_xml,
            isB2C: row.invoice_type === 'simplified_tax_invoice'
          };
        }
      }
      const egsRes = await client.query(
        `SELECT e.id, e.merchant_id, e.branch_id, e.current_icv, e.last_document_hash, 
                e.private_key_pem, e.csid_secret, e.certificate, e.expires_at, e.csid_environment,
                COALESCE(e.crn, m.crn) AS seller_crn,
                COALESCE(e.vat_number, m.vat_number) AS seller_vat,
                COALESCE(e.branch_name, m.store_name) AS seller_name_arabic
         FROM egs_units e
         LEFT JOIN merchant_tokens m ON e.merchant_id = m.merchant_id
         WHERE e.id = $1 FOR UPDATE OF e`,
        [egsUnitId]
      );

      if (egsRes.rows.length === 0) {
        throw new Error(`EGS Unit ${egsUnitId} not found`);
      }

      const egs = egsRes.rows[0];

      if (new Date(egs.expires_at) <= new Date()) {
        throw new Error(`EGS Unit ${egsUnitId} certificate expired on ${egs.expires_at}`);
      }

      const resolvedSellerCrn = overrides?.sellerCrn || egs.seller_crn;
      const resolvedSellerVat = overrides?.sellerVat || egs.seller_vat;
      const resolvedSellerName = overrides?.sellerNameArabic || egs.seller_name_arabic;

      if (!resolvedSellerVat) {
        throw new Error(`MISSING_SELLER_VAT: EGS Unit ${egsUnitId} has no VAT number configured in egs_units or merchant_tokens`);
      }
      if (!resolvedSellerCrn) {
        throw new Error(`MISSING_SELLER_CRN: EGS Unit ${egsUnitId} has no CRN configured in egs_units or merchant_tokens`);
      }
      if (!resolvedSellerName) {
        throw new Error(`MISSING_SELLER_NAME: EGS Unit ${egsUnitId} has no seller name configured in egs_units or merchant_tokens`);
      }

      const maxIcvRes = await client.query(
        `SELECT COALESCE(MAX(icv), 0) AS max_icv FROM invoices WHERE egs_unit_id = $1`,
        [egs.id]
      );
      const maxIcvInDb = Number(maxIcvRes?.rows?.[0]?.max_icv ?? 0);
      const nextIcv = Math.max(Number(egs.current_icv), maxIcvInDb) + 1;
      const currentPih = egs.last_document_hash;

      const rawXml = buildUblXmlFromSallaOrder({
        order,
        uuid: invoiceUuid,
        icv: nextIcv,
        pih: currentPih,
        issueDate,
        issueTime,
        sellerNameArabic: resolvedSellerName,
        sellerVat: resolvedSellerVat,
        sellerCrn: resolvedSellerCrn,
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
        sellerNameArabic: resolvedSellerName,
        sellerVatNumber: resolvedSellerVat,
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
  });
}

export async function processSallaRefundIntoZatcaCreditNote(
  client: PoolClient,
  egsUnitId: string,
  order: SallaOrderData,
  idempotencyKey: string,
  returnReason: string = 'Customer return or order refund',
  overrides?: ProcessInvoiceOverrides
): Promise<GeneratedInvoiceResult> {
  return withEgsMutex(egsUnitId, async () => {
    const isB2C = !isB2bCustomer(order.customer?.tax_number);
    const now = new Date();
    const issueDate = now.toISOString().split('T')[0];
    const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
    const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
    const creditNoteUuid = crypto.randomUUID();

    await client.query('BEGIN');

    try {
      if (idempotencyKey) {
        const existingRes = await client.query(
          `SELECT id, uuid, icv, pih, invoice_hash, qr_code_payload, signed_xml, invoice_type
           FROM invoices 
           WHERE idempotency_key = $1`,
          [idempotencyKey]
        );
        if (existingRes.rows.length > 0) {
          const row = existingRes.rows[0];
          await client.query('ROLLBACK');
          return {
            invoiceId: row.id,
            invoiceUuid: row.uuid,
            icv: Number(row.icv),
            pih: row.pih,
            invoiceHash: row.invoice_hash,
            qrCodeBase64: row.qr_code_payload,
            signedXml: row.signed_xml,
            isB2C: row.invoice_type === 'simplified_tax_invoice'
          };
        }
      }
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
      `SELECT e.id, e.merchant_id, e.current_icv, e.last_document_hash, 
              e.private_key_pem, e.csid_secret, e.certificate, e.expires_at, e.csid_environment,
              COALESCE(e.crn, m.crn) AS seller_crn,
              COALESCE(e.vat_number, m.vat_number) AS seller_vat,
              COALESCE(e.branch_name, m.store_name) AS seller_name_arabic
       FROM egs_units e
       LEFT JOIN merchant_tokens m ON e.merchant_id = m.merchant_id
       WHERE e.id = $1 FOR UPDATE OF e`,
      [egsUnitId]
    );

    if (egsRes.rows.length === 0) {
      throw new Error(`EGS Unit ${egsUnitId} not found`);
    }

    const egs = egsRes.rows[0];

    const resolvedSellerCrn = overrides?.sellerCrn || egs.seller_crn;
    const resolvedSellerVat = overrides?.sellerVat || egs.seller_vat;
    const resolvedSellerName = overrides?.sellerNameArabic || egs.seller_name_arabic;

    if (!resolvedSellerVat) {
      throw new Error(`MISSING_SELLER_VAT: EGS Unit ${egsUnitId} has no VAT number configured in egs_units or merchant_tokens`);
    }
    if (!resolvedSellerCrn) {
      throw new Error(`MISSING_SELLER_CRN: EGS Unit ${egsUnitId} has no CRN configured in egs_units or merchant_tokens`);
    }
    if (!resolvedSellerName) {
      throw new Error(`MISSING_SELLER_NAME: EGS Unit ${egsUnitId} has no seller name configured in egs_units or merchant_tokens`);
    }

    const maxIcvRes = await client.query(
      `SELECT COALESCE(MAX(icv), 0) AS max_icv FROM invoices WHERE egs_unit_id = $1`,
      [egs.id]
    );
    const maxIcvInDb = Number(maxIcvRes?.rows?.[0]?.max_icv ?? 0);
    const nextIcv = Math.max(Number(egs.current_icv), maxIcvInDb) + 1;
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
      sellerNameArabic: resolvedSellerName,
      sellerVat: resolvedSellerVat,
      sellerCrn: resolvedSellerCrn,
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
      sellerNameArabic: resolvedSellerName,
      sellerVatNumber: resolvedSellerVat,
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
  });
}

export interface ProcessPartialCreditNoteOptions {
  originalInvoiceId?: string;
  externalOriginalInvoiceNumber?: string;
  externalOriginalInvoiceDate?: string;
  externalOriginalUuid?: string;
  isB2C?: boolean;
  refundAmount: number;
  returnReason?: string;
  items?: Array<{ name: string; quantity: number; price: number }>;
  idempotencyKey?: string;
  sellerNameArabic?: string;
  sellerVat?: string;
  sellerCrn?: string;
}

export async function processPartialCreditNote(
  client: PoolClient,
  egsUnitId: string,
  options: ProcessPartialCreditNoteOptions
): Promise<GeneratedInvoiceResult> {
  return withEgsMutex(egsUnitId, async () => {
    const returnReason = options.returnReason || 'Partial customer refund';
    const now = new Date();
    const issueDate = now.toISOString().split('T')[0];
    const issueTime = `${now.toISOString().split('T')[1].slice(0, 8)}Z`;
    const issueDateTimeIsoZ = `${issueDate}T${issueTime}`;
    const creditNoteUuid = crypto.randomUUID();

    await client.query('BEGIN');

    try {
      if (options.idempotencyKey) {
        const existingRes = await client.query(
          `SELECT id, uuid, icv, pih, invoice_hash, qr_code_payload, signed_xml, invoice_type
           FROM invoices 
           WHERE idempotency_key = $1`,
          [options.idempotencyKey]
        );
        if (existingRes.rows.length > 0) {
          const row = existingRes.rows[0];
          await client.query('ROLLBACK');
          return {
            invoiceId: row.id,
            invoiceUuid: row.uuid,
            icv: Number(row.icv),
            pih: row.pih,
            invoiceHash: row.invoice_hash,
            qrCodeBase64: row.qr_code_payload,
            signedXml: row.signed_xml,
            isB2C: row.invoice_type === 'simplified_tax_invoice'
          };
        }
      }
    let originalInvoice: any = null;
    if (options.originalInvoiceId) {
      const origRes = await client.query(
        `SELECT id, uuid, icv, status, grand_total, currency, invoice_type, order_id 
         FROM invoices 
         WHERE id = $1 OR uuid = $1
         LIMIT 1`,
        [options.originalInvoiceId]
      );

      if (origRes.rows.length > 0) {
        originalInvoice = origRes.rows[0];
      }
    }

    if (!originalInvoice) {
      if (options.externalOriginalInvoiceNumber) {
        // Historical pre-installation invoice reference
        originalInvoice = {
          id: options.externalOriginalUuid || crypto.randomUUID(),
          uuid: options.externalOriginalUuid || options.externalOriginalInvoiceNumber,
          icv: 0,
          status: 'external_historical',
          grand_total: options.refundAmount * 10,
          currency: 'SAR',
          invoice_type: options.isB2C === false ? 'tax_invoice' : 'simplified_tax_invoice',
          order_id: options.externalOriginalInvoiceNumber
        };
      } else {
        throw new Error(
          `Original invoice ${options.originalInvoiceId || 'unspecified'} not found. For historical orders created before bridge installation, provide externalOriginalInvoiceNumber.`
        );
      }
    }

    const origGrandTotal = Number(originalInvoice.grand_total);

    if (options.refundAmount <= 0) {
      throw new Error('Refund amount must be strictly positive');
    }
    if (options.refundAmount > origGrandTotal) {
      throw new Error(`Partial refund amount (${options.refundAmount}) cannot exceed original invoice total (${origGrandTotal})`);
    }

    const egsRes = await client.query(
      `SELECT e.id, e.merchant_id, e.current_icv, e.last_document_hash, 
              e.private_key_pem, e.csid_secret, e.certificate, e.expires_at, e.csid_environment,
              COALESCE(e.crn, m.crn) AS seller_crn,
              COALESCE(e.vat_number, m.vat_number) AS seller_vat,
              COALESCE(e.branch_name, m.store_name) AS seller_name_arabic
       FROM egs_units e
       LEFT JOIN merchant_tokens m ON e.merchant_id = m.merchant_id
       WHERE e.id = $1 FOR UPDATE OF e`,
      [egsUnitId]
    );

    if (egsRes.rows.length === 0) {
      throw new Error(`EGS Unit ${egsUnitId} not found`);
    }

    const egs = egsRes.rows[0];

    const resolvedSellerCrn = options.sellerCrn || egs.seller_crn;
    const resolvedSellerVat = options.sellerVat || egs.seller_vat;
    const resolvedSellerName = options.sellerNameArabic || egs.seller_name_arabic;

    if (!resolvedSellerVat) {
      throw new Error(`MISSING_SELLER_VAT: EGS Unit ${egsUnitId} has no VAT number configured in egs_units or merchant_tokens`);
    }
    if (!resolvedSellerCrn) {
      throw new Error(`MISSING_SELLER_CRN: EGS Unit ${egsUnitId} has no CRN configured in egs_units or merchant_tokens`);
    }
    if (!resolvedSellerName) {
      throw new Error(`MISSING_SELLER_NAME: EGS Unit ${egsUnitId} has no seller name configured in egs_units or merchant_tokens`);
    }

    const maxIcvRes = await client.query(
      `SELECT COALESCE(MAX(icv), 0) AS max_icv FROM invoices WHERE egs_unit_id = $1`,
      [egs.id]
    );
    const maxIcvInDb = Number(maxIcvRes?.rows?.[0]?.max_icv ?? 0);
    const nextIcv = Math.max(Number(egs.current_icv), maxIcvInDb) + 1;
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
        tax_number: isB2C ? null : resolvedSellerVat
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
      sellerNameArabic: resolvedSellerName,
      sellerVat: resolvedSellerVat,
      sellerCrn: resolvedSellerCrn,
      isB2C
    });

    const privateKey = decryptVaultPrivateKey(egs.private_key_pem);
    const signed = signZatcaInvoiceExact({
      rawXml: rawCreditNoteXml,
      privateKeyPem: privateKey,
      certPem: egs.certificate,
      sellerNameArabic: resolvedSellerName,
      sellerVatNumber: resolvedSellerVat,
      grandTotal: options.refundAmount.toFixed(2),
      vatTotal: vatRefund.toFixed(2),
      issueDateTimeIsoZ,
      isB2C
    });

    const idempotency = options.idempotencyKey || `cn_part_${originalInvoice.id}_${Date.now()}`;

    const dbReplacesInvoiceId = options.originalInvoiceId && originalInvoice.status !== 'external_historical'
      ? originalInvoice.id
      : null;

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
        dbReplacesInvoiceId,
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
  });
}

/**
 * Resubmits a corrected transaction following a ZATCA clearance or reporting rejection.
 *
 * In accordance with ZATCA Phase 2 Guidelines:
 * 1. The original rejected document remains strictly immutable in the database (status = 'rejected').
 * 2. The rejected document's UUID, ICV, and hash MUST NEVER be altered or reused.
 * 3. The new resubmitted invoice receives a brand new UUID, incremented ICV, current timestamp,
 *    and its Previous Invoice Hash (PIH) strictly references the preceding generated document
 *    (which is the hash of the rejected document).
 */
export async function resubmitCorrectedZatcaInvoice(
  client: PoolClient,
  rejectedInvoiceId: string,
  correctedOrder?: SallaOrderData,
  overrides?: ProcessInvoiceOverrides
): Promise<GeneratedInvoiceResult> {
  const rejectedRes = await client.query(
    `SELECT i.id, i.uuid, i.egs_unit_id, i.order_id, i.idempotency_key, i.icv, i.invoice_hash,
            i.status, i.invoice_type, i.signed_xml, i.currency, u.merchant_id
     FROM invoices i
     JOIN egs_units u ON i.egs_unit_id = u.id
     WHERE i.id = $1`,
    [rejectedInvoiceId]
  );

  if (!rejectedRes || rejectedRes.rows.length === 0) {
    throw new Error(`Rejected invoice ${rejectedInvoiceId} not found`);
  }

  const rejected = rejectedRes.rows[0];
  if (rejected.status !== 'rejected' && rejected.status !== 'rejected_reporting') {
    throw new Error(`Invoice ${rejectedInvoiceId} has status '${rejected.status}'. Only rejected documents can be corrected via new document identity.`);
  }

  const newIdempotency = `${rejected.idempotency_key}:resubmit:${Date.now()}`;

  let orderToProcess: SallaOrderData;
  if (correctedOrder) {
    orderToProcess = correctedOrder;
  } else {
    const syncRes = await client.query(
      `SELECT order_amount, order_currency FROM order_sync_records WHERE merchant_id = $1 AND order_id = $2`,
      [rejected.merchant_id, rejected.order_id]
    );
    const amount = Number(syncRes.rows?.[0]?.order_amount || 115);
    const currency = syncRes.rows?.[0]?.order_currency || rejected.currency || 'SAR';
    const subtotal = Number((amount / 1.15).toFixed(2));
    const tax = Number((amount - subtotal).toFixed(2));

    orderToProcess = {
      id: Number(rejected.order_id) || 1001,
      currency,
      customer: { first_name: 'Customer', email: 'customer@example.com' },
      items: [
        {
          id: 1,
          name: 'Corrected Item Supply',
          quantity: 1,
          price: { amount: subtotal, currency }
        }
      ],
      amounts: {
        sub_total: { amount: subtotal, currency },
        tax: { amount: { amount: tax, currency } },
        total: { amount, currency }
      }
    } as any;
  }

  return await processSallaOrderIntoZatcaInvoice(
    client,
    rejected.egs_unit_id,
    orderToProcess,
    newIdempotency,
    overrides
  );
}

/**
 * ZATCA Phase 2: Remedy for Simplified Invoice Reporting Rejection (NOT_REPORTED).
 * Per ZATCA Technical Guidelines FAQ:
 * An invoice rejected at reporting is invalid. The taxpayer must:
 * 1. Issue a Credit Note (381) cancelling the invalid invoice in the tax ledger.
 * 2. Issue a replacement Simplified Tax Invoice with corrected data.
 * Both documents increment ICV and advance the cryptographic hash chain.
 */
export async function remedyRejectedSimplifiedInvoice(
  client: PoolClient,
  rejectedInvoiceId: string,
  correctedOrder?: SallaOrderData,
  overrides?: ProcessInvoiceOverrides
): Promise<{ creditNote: GeneratedInvoiceResult; replacementInvoice: GeneratedInvoiceResult }> {
  const rejectedRes = await client.query(
    `SELECT i.id, i.uuid, i.egs_unit_id, i.order_id, i.idempotency_key, i.icv, i.invoice_hash,
            i.status, i.invoice_type, i.signed_xml, i.currency, i.grand_total, u.merchant_id
     FROM invoices i
     JOIN egs_units u ON i.egs_unit_id = u.id
     WHERE i.id = $1`,
    [rejectedInvoiceId]
  );

  if (!rejectedRes || rejectedRes.rows.length === 0) {
    throw new Error(`Invoice ${rejectedInvoiceId} not found`);
  }

  const rejected = rejectedRes.rows[0];
  if (rejected.status !== 'rejected_reporting' && rejected.status !== 'rejected') {
    throw new Error(`Invoice ${rejectedInvoiceId} has status '${rejected.status}'. Only reporting-rejected invoices require cancellation credit note remedy.`);
  }

  // 1. Issue Credit Note (381) cancelling the invalid invoice in the ledger
  const creditNote = await processPartialCreditNote(client, rejected.egs_unit_id, {
    originalInvoiceId: rejected.id,
    refundAmount: Number(rejected.grand_total),
    returnReason: 'إلغاء فاتورة ضريبية مبسطة مرفوضة من منصة فاتورة (ZATCA NOT_REPORTED Cancellation)',
    currency: rejected.currency || 'SAR'
  });

  // 2. Issue replacement Simplified Tax Invoice
  const replacementInvoice = await resubmitCorrectedZatcaInvoice(
    client,
    rejectedInvoiceId,
    correctedOrder,
    overrides
  );

  return { creditNote, replacementInvoice };
}
