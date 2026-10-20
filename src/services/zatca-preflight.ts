import { DOMParser } from '@xmldom/xmldom';
import { parseTlvQrBuffer, TlvEntry } from '../crypto/zatca-signer.js';

export interface PreflightFinding {
  code: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  category: 'SCHEMA' | 'CRYPTOGRAPHY' | 'TAX_MATH' | 'BUSINESS_RULES' | 'ENCODING';
  field?: string;
  messageEn: string;
  messageAr: string;
  resolutionEn: string;
  resolutionAr: string;
  fineImpactSar?: number;
}

export interface TlvInspection {
  sellerName?: string;
  vatNumber?: string;
  timestamp?: string;
  invoiceTotal?: string;
  vatTotal?: string;
  hashPresent?: boolean;
  signaturePresent?: boolean;
  publicKeyPresent?: boolean;
  tagLengthsValid: boolean;
  base64Length: number;
}

export interface PreflightValidationResult {
  valid: boolean;
  documentType: 'Standard' | 'Simplified' | 'CreditNote' | 'DebitNote' | 'Unknown';
  score: number;
  summary: {
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    warningChecks: number;
    fineRiskSar: number;
  };
  findings: PreflightFinding[];
  tlvInspection?: TlvInspection;
}

const VAT_REGEX = /^3\d{13}3$/;
const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}:\d{2}$/;
const BASE64_SHA256_REGEX = /^[A-Za-z0-9+/]{43}=$/;

export function validateZatcaPreflight(content: string, format: 'xml' | 'salla_json' = 'xml'): PreflightValidationResult {
  const findings: PreflightFinding[] = [];
  let totalChecks = 0;
  let passedChecks = 0;

  function recordCheck(passed: boolean, findingIfFailed: PreflightFinding) {
    totalChecks++;
    if (passed) {
      passedChecks++;
    } else {
      findings.push(findingIfFailed);
    }
  }

  let xmlDoc: Document | null = null;
  let rawXml = content;

  if (format === 'salla_json') {
    try {
      const parsedJson = JSON.parse(content);
      return validateSallaPayloadPreflight(parsedJson);
    } catch (err: any) {
      return {
        valid: false,
        documentType: 'Unknown',
        score: 0,
        summary: {
          totalChecks: 1,
          passedChecks: 0,
          failedChecks: 1,
          warningChecks: 0,
          fineRiskSar: 5000
        },
        findings: [
          {
            code: 'INVALID_JSON',
            severity: 'ERROR',
            category: 'SCHEMA',
            messageEn: 'Malformed JSON payload: ' + err.message,
            messageAr: 'بيانات JSON غير صالحة أو تالفة: ' + err.message,
            resolutionEn: 'Ensure valid JSON format is supplied.',
            resolutionAr: 'تأكد من إرسال كود JSON صحيح.',
            fineImpactSar: 5000
          }
        ]
      };
    }
  }

  // 1. Check Unicode NFC normalization
  const isNfc = rawXml === rawXml.normalize('NFC');
  recordCheck(isNfc, {
    code: 'BR-KSA-ENCODING-NFC',
    severity: 'ERROR',
    category: 'ENCODING',
    messageEn: 'XML contains non-NFC normalized Unicode characters.',
    messageAr: 'الملف يحتوي على نصوص يونيكود غير متوافقة مع معيار NFC المعتمد لدى هيئة الزكاة.',
    resolutionEn: 'Normalize all Arabic strings using String.prototype.normalize("NFC") before generating XML.',
    resolutionAr: 'قم بتطبيق صيغة NFC على جميع النصوص العربية قبل بناء ملف الـ XML.',
    fineImpactSar: 5000
  });

  // 2. XML Parsing check
  let parseErrors: string[] = [];
  try {
    const parser = new DOMParser({
      errorHandler: {
        warning: () => {},
        error: (msg: string) => parseErrors.push(msg),
        fatalError: (msg: string) => parseErrors.push(msg)
      }
    });
    xmlDoc = parser.parseFromString(rawXml, 'text/xml');
  } catch (err: any) {
    parseErrors.push(err.message);
  }

  if (parseErrors.length > 0 || !xmlDoc || !xmlDoc.documentElement) {
    return {
      valid: false,
      documentType: 'Unknown',
      score: 0,
      summary: {
        totalChecks: 1,
        passedChecks: 0,
        failedChecks: 1,
        warningChecks: 0,
        fineRiskSar: 10000
      },
      findings: [
        {
          code: 'XML_PARSE_FAILURE',
          severity: 'ERROR',
          category: 'SCHEMA',
          messageEn: 'Failed to parse XML: ' + parseErrors.join('; '),
          messageAr: 'فشل تحليل ملف الـ XML: ' + parseErrors.join('; '),
          resolutionEn: 'Ensure the invoice XML is well-formed without unclosed tags or invalid entities.',
          resolutionAr: 'تأكد من أن ملف XML سليم وخالٍ من الوسوم غير المغلقة أو المحارف غير الصالحة.',
          fineImpactSar: 10000
        }
      ]
    };
  }

  const root = xmlDoc.documentElement;
  const isInvoice = root.localName === 'Invoice' || root.nodeName.endsWith(':Invoice');
  const isCreditNote = root.localName === 'CreditNote' || root.nodeName.endsWith(':CreditNote');
  const isDebitNote = root.localName === 'DebitNote' || root.nodeName.endsWith(':DebitNote');

  recordCheck(isInvoice || isCreditNote || isDebitNote, {
    code: 'BR-KSA-ROOT-ELEMENT',
    severity: 'ERROR',
    category: 'SCHEMA',
    messageEn: 'Root element must be Invoice, CreditNote, or DebitNote.',
    messageAr: 'العنصر الرئيسي يجب أن يكون Invoice أو CreditNote أو DebitNote.',
    resolutionEn: 'Use UBL 2.1 Invoice or CreditNote standard envelope.',
    resolutionAr: 'استخدم معيار UBL 2.1 المعتمد لهيكل الفاتورة أو إشعار الدائن.',
    fineImpactSar: 5000
  });

  // Helper element queries
  function getElementText(parent: Element | Document, localName: string): string | null {
    const elements = parent.getElementsByTagName('*');
    for (let i = 0; i < elements.length; i++) {
      const item = elements.item(i);
      if (item && (item.localName === localName || item.nodeName.endsWith(':' + localName))) {
        return item.textContent ? item.textContent.trim() : '';
      }
    }
    return null;
  }

  function getAttributeValue(parent: Element | Document, localName: string, attrName: string): string | null {
    const elements = parent.getElementsByTagName('*');
    for (let i = 0; i < elements.length; i++) {
      const item = elements.item(i);
      if (item && (item.localName === localName || item.nodeName.endsWith(':' + localName))) {
        return item.getAttribute(attrName);
      }
    }
    return null;
  }

  // 3. Document type and subtype
  const invoiceTypeCode = getElementText(xmlDoc, 'InvoiceTypeCode');
  const invoiceTypeName = getAttributeValue(xmlDoc, 'InvoiceTypeCode', 'name');
  let docType: 'Standard' | 'Simplified' | 'CreditNote' | 'DebitNote' | 'Unknown' = 'Unknown';

  if (isCreditNote || invoiceTypeCode === '381') {
    docType = 'CreditNote';
  } else if (isDebitNote || invoiceTypeCode === '383') {
    docType = 'DebitNote';
  } else if (invoiceTypeName && invoiceTypeName.startsWith('01')) {
    docType = 'Standard';
  } else if (invoiceTypeName && invoiceTypeName.startsWith('02')) {
    docType = 'Simplified';
  }

  recordCheck(invoiceTypeCode !== null && ['388', '381', '383'].includes(invoiceTypeCode), {
    code: 'BR-KSA-03',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cbc:InvoiceTypeCode',
    messageEn: 'InvoiceTypeCode must be 388 (Tax Invoice), 381 (Credit Note), or 383 (Debit Note).',
    messageAr: 'رمز نوع الفاتورة يجب أن يكون 388 (فاتورة ضريبية)، 381 (إشعار دائن)، أو 383 (إشعار مدين).',
    resolutionEn: 'Set cbc:InvoiceTypeCode to 388, 381, or 383.',
    resolutionAr: 'قم بضبط cbc:InvoiceTypeCode إلى 388 أو 381 أو 383.',
    fineImpactSar: 5000
  });

  recordCheck(invoiceTypeName !== null && (invoiceTypeName.startsWith('01') || invoiceTypeName.startsWith('02')), {
    code: 'BR-KSA-04',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cbc:InvoiceTypeCode/@name',
    messageEn: 'Invoice subtype attribute "name" must start with 01 (Standard) or 02 (Simplified).',
    messageAr: 'الخاصية name في رمز نوع الفاتورة يجب أن تبدأ بـ 01 (ضريبية قياسية) أو 02 (ضريبية مبسطة).',
    resolutionEn: 'Set name="0100000" for B2B standard invoices or name="0200000" for B2C simplified invoices.',
    resolutionAr: 'قم بتعيين name="0100000" لفواتير B2B أو name="0200000" لفواتير B2C المبسطة.',
    fineImpactSar: 5000
  });

  // 4. UUID & Format
  const uuid = getElementText(xmlDoc, 'UUID');
  recordCheck(uuid !== null && UUID_REGEX.test(uuid), {
    code: 'BR-KSA-UUID',
    severity: 'ERROR',
    category: 'SCHEMA',
    field: 'cbc:UUID',
    messageEn: 'cbc:UUID must be a valid 128-bit UUID (RFC 4122).',
    messageAr: 'المعرف الموحد UUID يجب أن يكون بصيغة RFC 4122 صالحة (36 حرفاً متضمنة الشُرط).',
    resolutionEn: 'Generate a standard RFC 4122 UUID v4.',
    resolutionAr: 'قم بتوليد معرف UUID v4 قياسي.',
    fineImpactSar: 5000
  });

  // 5. Issue Date & Issue Time
  const issueDate = getElementText(xmlDoc, 'IssueDate');
  const issueTime = getElementText(xmlDoc, 'IssueTime');
  recordCheck(issueDate !== null && DATE_REGEX.test(issueDate), {
    code: 'BR-KSA-ISSUE-DATE',
    severity: 'ERROR',
    category: 'SCHEMA',
    field: 'cbc:IssueDate',
    messageEn: 'cbc:IssueDate must be in format YYYY-MM-DD.',
    messageAr: 'تاريخ إصدار الفاتورة يجب أن يكون بصيغة YYYY-MM-DD.',
    resolutionEn: 'Format date as YYYY-MM-DD.',
    resolutionAr: 'نسق التاريخ بصيغة سنة-شهر-يوم.',
    fineImpactSar: 2500
  });
  recordCheck(issueTime !== null && TIME_REGEX.test(issueTime), {
    code: 'BR-KSA-ISSUE-TIME',
    severity: 'ERROR',
    category: 'SCHEMA',
    field: 'cbc:IssueTime',
    messageEn: 'cbc:IssueTime must be in format HH:MM:SS.',
    messageAr: 'وقت إصدار الفاتورة يجب أن يكون بصيغة HH:MM:SS.',
    resolutionEn: 'Format time as HH:MM:SS (24-hour UTC or KSA local time).',
    resolutionAr: 'نسق الوقت بصيغة ساعة:دقيقة:ثانية بنظام 24 ساعة.',
    fineImpactSar: 2500
  });

  // 6. Currency codes
  const docCurrency = getElementText(xmlDoc, 'DocumentCurrencyCode');
  const taxCurrency = getElementText(xmlDoc, 'TaxCurrencyCode');
  recordCheck(docCurrency === 'SAR', {
    code: 'BR-KSA-25-DOC-CURRENCY',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cbc:DocumentCurrencyCode',
    messageEn: 'DocumentCurrencyCode must be SAR.',
    messageAr: 'عملة الفاتورة يجب أن تكون بالريال السعودي (SAR).',
    resolutionEn: 'Set cbc:DocumentCurrencyCode to SAR.',
    resolutionAr: 'عين رمز العملة SAR.',
    fineImpactSar: 5000
  });
  recordCheck(taxCurrency === 'SAR', {
    code: 'BR-KSA-25-TAX-CURRENCY',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cbc:TaxCurrencyCode',
    messageEn: 'TaxCurrencyCode must be SAR.',
    messageAr: 'عملة احتساب الضريبة يجب أن تكون بالريال السعودي (SAR).',
    resolutionEn: 'Set cbc:TaxCurrencyCode to SAR.',
    resolutionAr: 'عين عملة الضريبة SAR.',
    fineImpactSar: 5000
  });

  // 7. Supplier Party & VAT number
  const supplierParty = xmlDoc.getElementsByTagName('cac:AccountingSupplierParty').item(0) ||
                       xmlDoc.getElementsByTagName('AccountingSupplierParty').item(0);
  let supplierVat = '';
  let supplierName = '';
  let supplierBuilding = '';
  let supplierPostal = '';

  if (supplierParty) {
    supplierName = getElementText(supplierParty, 'RegistrationName') || '';
    supplierVat = getElementText(supplierParty, 'CompanyID') || '';
    supplierBuilding = getElementText(supplierParty, 'BuildingNumber') || '';
    supplierPostal = getElementText(supplierParty, 'PostalZone') || '';
  }

  recordCheck(supplierParty !== null, {
    code: 'BR-KSA-SUPPLIER-EXISTS',
    severity: 'ERROR',
    category: 'SCHEMA',
    field: 'cac:AccountingSupplierParty',
    messageEn: 'AccountingSupplierParty is mandatory.',
    messageAr: 'بيانات المورد (المنشأة المصدرة) إلزامية ولا يمكن إغفالها.',
    resolutionEn: 'Add cac:AccountingSupplierParty block with full tax details.',
    resolutionAr: 'أضف بيانات المورد كاملة متضمنة الرقم الضريبي والعنوان الوطني.',
    fineImpactSar: 10000
  });

  recordCheck(VAT_REGEX.test(supplierVat), {
    code: 'BR-KSA-08',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cac:AccountingSupplierParty/.../cbc:CompanyID',
    messageEn: `Supplier VAT number "${supplierVat}" is invalid. Must be 15 digits starting and ending with 3.`,
    messageAr: `الرقم الضريبي للمورد "${supplierVat}" غير صحيح. يجب أن يتكون من 15 رقماً ويبدأ وينتهي بالرقم 3.`,
    resolutionEn: 'Enter the merchant 15-digit ZATCA VAT registration number.',
    resolutionAr: 'أدخل الرقم الضريبي النظامي المعتمد من هيئة الزكاة للمنشأة.',
    fineImpactSar: 10000
  });

  recordCheck(/^\d{4}$/.test(supplierBuilding), {
    code: 'BR-KSA-26',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cac:AccountingSupplierParty/.../cbc:BuildingNumber',
    messageEn: `Supplier building number "${supplierBuilding}" must be exactly 4 digits.`,
    messageAr: `رقم المبنى للمورد "${supplierBuilding}" يجب أن يتكون من 4 أرقام بالضبط حسب العنوان الوطني.`,
    resolutionEn: 'Provide 4-digit Saudi national address building number.',
    resolutionAr: 'أدخل رقم المبنى المكون من 4 أرقام من واقع العنوان الوطني السعودي.',
    fineImpactSar: 2500
  });

  recordCheck(/^\d{5}$/.test(supplierPostal), {
    code: 'BR-KSA-27',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cac:AccountingSupplierParty/.../cbc:PostalZone',
    messageEn: `Supplier postal zone "${supplierPostal}" must be exactly 5 digits.`,
    messageAr: `الرمز البريدي للمورد "${supplierPostal}" يجب أن يتكون من 5 أرقام بالضبط.`,
    resolutionEn: 'Provide 5-digit postal code.',
    resolutionAr: 'أدخل الرمز البريدي الصحيح المكون من 5 أرقام.',
    fineImpactSar: 2500
  });

  // 8. B2B Customer checks if Standard Invoice
  if (docType === 'Standard') {
    const customerParty = xmlDoc.getElementsByTagName('cac:AccountingCustomerParty').item(0) ||
                         xmlDoc.getElementsByTagName('AccountingCustomerParty').item(0);
    let customerVat = '';
    if (customerParty) {
      customerVat = getElementText(customerParty, 'CompanyID') || '';
    }

    recordCheck(customerParty !== null, {
      code: 'BR-KSA-CUSTOMER-EXISTS',
      severity: 'ERROR',
      category: 'BUSINESS_RULES',
      field: 'cac:AccountingCustomerParty',
      messageEn: 'Standard B2B tax invoices must include AccountingCustomerParty.',
      messageAr: 'الفاتورة الضريبية القياسية (B2B) تشترط وجود بيانات العميل الضريبية.',
      resolutionEn: 'Add full customer party details with national address and VAT ID.',
      resolutionAr: 'أضف بيانات العميل التجارية متضمنة العنوان الوطني والرقم الضريبي.',
      fineImpactSar: 10000
    });

    recordCheck(VAT_REGEX.test(customerVat), {
      code: 'BR-KSA-09',
      severity: 'ERROR',
      category: 'BUSINESS_RULES',
      field: 'cac:AccountingCustomerParty/.../cbc:CompanyID',
      messageEn: `Buyer VAT number "${customerVat}" is invalid for standard B2B invoice.`,
      messageAr: `الرقم الضريبي للعميل "${customerVat}" غير صالح للفاتورة القياسية B2B. يجب أن يكون 15 رقماً يبدأ وينتهي بـ 3.`,
      resolutionEn: 'Verify and supply the corporate buyer 15-digit VAT number.',
      resolutionAr: 'تحقق من صحة الرقم الضريبي للمشتري المكون من 15 رقماً.',
      fineImpactSar: 10000
    });
  }

  // 9. Credit Note BillingReference check
  if (docType === 'CreditNote' || docType === 'DebitNote') {
    const billingRef = xmlDoc.getElementsByTagName('cac:BillingReference').item(0) ||
                       xmlDoc.getElementsByTagName('BillingReference').item(0);
    const instructionNote = getElementText(xmlDoc, 'InstructionNote');

    recordCheck(billingRef !== null, {
      code: 'BR-KSA-51',
      severity: 'ERROR',
      category: 'BUSINESS_RULES',
      field: 'cac:BillingReference',
      messageEn: 'Credit Note (381) must reference the original invoice via cac:BillingReference.',
      messageAr: 'إشعار الدائن (381) يجب أن يشير للفاتورة الأصلية الملغاة عبر cac:BillingReference.',
      resolutionEn: 'Add cac:BillingReference/cac:InvoiceDocumentReference pointing to original invoice ID.',
      resolutionAr: 'أضف مرجع الفاتورة الأصلية داخل عنصر BillingReference.',
      fineImpactSar: 5000
    });

    recordCheck(instructionNote !== null && instructionNote.length > 0, {
      code: 'BR-KSA-52',
      severity: 'ERROR',
      category: 'BUSINESS_RULES',
      field: 'cbc:InstructionNote',
      messageEn: 'Credit and Debit notes must include a reason in cbc:InstructionNote.',
      messageAr: 'إشعارات الدائن والمدين يجب أن تتضمن سبب الإلغاء أو الاسترجاع في cbc:InstructionNote.',
      resolutionEn: 'Specify return/cancellation reason in cbc:InstructionNote.',
      resolutionAr: 'حدد سبب الإرجاع أو التصحيح في خانة ملاحظات التعليمات.',
      fineImpactSar: 5000
    });
  }

  // 10. ICV & PIH checks
  const addRefs = xmlDoc.getElementsByTagName('cac:AdditionalDocumentReference');
  let hasIcv = false;
  let hasPih = false;
  let pihValue = '';
  let icvValue = '';

  for (let i = 0; i < addRefs.length; i++) {
    const ref = addRefs.item(i);
    if (!ref) continue;
    const id = getElementText(ref, 'ID');
    if (id === 'ICV') {
      hasIcv = true;
      icvValue = getElementText(ref, 'UUID') || '';
    } else if (id === 'PIH') {
      hasPih = true;
      const pihNode = ref.getElementsByTagName('cac:Attachment').item(0) ||
                      ref.getElementsByTagName('Attachment').item(0);
      if (pihNode) {
        pihValue = getElementText(pihNode, 'EmbeddedDocumentBinaryObject') || '';
      }
    }
  }

  recordCheck(hasIcv && /^\d+$/.test(icvValue) && parseInt(icvValue, 10) > 0, {
    code: 'BR-KSA-33',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'cac:AdditionalDocumentReference (ICV)',
    messageEn: `ICV counter "${icvValue}" must be a strictly positive integer.`,
    messageAr: `عداد تسلسل الفاتورة (ICV) "${icvValue}" يجب أن يكون رقماً صحيحاً متسلسلاً أكبر من صفر.`,
    resolutionEn: 'Ensure consecutive integer ICV counter per EGS unit.',
    resolutionAr: 'تأكد من تسلسل عداد الفاتورة بشكل تصاعدي لكل جهاز.',
    fineImpactSar: 5000
  });

  recordCheck(hasPih && (BASE64_SHA256_REGEX.test(pihValue) || pihValue === 'NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI='), {
    code: 'BR-KSA-31',
    severity: 'ERROR',
    category: 'CRYPTOGRAPHY',
    field: 'cac:AdditionalDocumentReference (PIH)',
    messageEn: 'PIH must be a valid 44-character Base64 SHA-256 hash.',
    messageAr: 'هاش الفاتورة السابقة (PIH) يجب أن يكون هاش SHA-256 مشفر Base64 بطول 44 محرفاً.',
    resolutionEn: 'Pass the exact Base64 SHA-256 hash of the immediately preceding invoice.',
    resolutionAr: 'مرر الهاش المشفر للفاتورة السابقة مباشرة بنفس الجهاز.',
    fineImpactSar: 5000
  });

  // 11. Mathematical and Tax Totals Checks
  const legalTotal = xmlDoc.getElementsByTagName('cac:LegalMonetaryTotal').item(0) ||
                     xmlDoc.getElementsByTagName('LegalMonetaryTotal').item(0);
  let lineExtensionTotal = 0;
  let taxExclusiveAmount = 0;
  let taxInclusiveAmount = 0;
  let payableAmount = 0;

  if (legalTotal) {
    lineExtensionTotal = parseFloat(getElementText(legalTotal, 'LineExtensionAmount') || '0');
    taxExclusiveAmount = parseFloat(getElementText(legalTotal, 'TaxExclusiveAmount') || '0');
    taxInclusiveAmount = parseFloat(getElementText(legalTotal, 'TaxInclusiveAmount') || '0');
    payableAmount = parseFloat(getElementText(legalTotal, 'PayableAmount') || '0');
  }

  const invoiceLines = xmlDoc.getElementsByTagName('cac:InvoiceLine');
  let computedLineSum = 0;
  for (let i = 0; i < invoiceLines.length; i++) {
    const line = invoiceLines.item(i);
    if (!line) continue;
    const lineAmt = parseFloat(getElementText(line, 'LineExtensionAmount') || '0');
    computedLineSum += lineAmt;
  }

  recordCheck(invoiceLines.length > 0, {
    code: 'BR-KSA-LINES-EXIST',
    severity: 'ERROR',
    category: 'SCHEMA',
    field: 'cac:InvoiceLine',
    messageEn: 'Invoice must contain at least one InvoiceLine.',
    messageAr: 'الفاتورة يجب أن تحتوي على بند واحد على الأقل.',
    resolutionEn: 'Add at least one line item.',
    resolutionAr: 'أضف بنداً واحداً على الأقل للفاتورة.',
    fineImpactSar: 5000
  });

  recordCheck(Math.abs(computedLineSum - lineExtensionTotal) < 0.02, {
    code: 'BR-CO-10',
    severity: 'ERROR',
    category: 'TAX_MATH',
    field: 'cac:LegalMonetaryTotal/cbc:LineExtensionAmount',
    messageEn: `Sum of invoice lines (${computedLineSum.toFixed(2)}) does not match LegalMonetaryTotal LineExtensionAmount (${lineExtensionTotal.toFixed(2)}).`,
    messageAr: `مجموع مبالغ البنود (${computedLineSum.toFixed(2)}) لا يتطابق مع إجمالي مبالغ البنود في الملخص المالي (${lineExtensionTotal.toFixed(2)}).`,
    resolutionEn: 'Ensure sum of line items strictly equals LegalMonetaryTotal/LineExtensionAmount.',
    resolutionAr: 'اضبط مبالغ البنود لتتطابق تماماً مع إجمالي الفاتورة.',
    fineImpactSar: 5000
  });

  // Extract TaxTotal TaxAmount
  const taxTotalNodes = xmlDoc.getElementsByTagName('cac:TaxTotal');
  let declaredVatAmount = 0;
  if (taxTotalNodes.length > 0) {
    declaredVatAmount = parseFloat(getElementText(taxTotalNodes.item(0)!, 'TaxAmount') || '0');
  }

  recordCheck(Math.abs((taxExclusiveAmount + declaredVatAmount) - taxInclusiveAmount) < 0.02, {
    code: 'BR-CO-15',
    severity: 'ERROR',
    category: 'TAX_MATH',
    field: 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount',
    messageEn: `TaxInclusiveAmount (${taxInclusiveAmount.toFixed(2)}) must equal TaxExclusiveAmount (${taxExclusiveAmount.toFixed(2)}) + TaxAmount (${declaredVatAmount.toFixed(2)}).`,
    messageAr: `المبلغ شامل الضريبة (${taxInclusiveAmount.toFixed(2)}) يجب أن يساوي المبلغ غير شامل الضريبة (${taxExclusiveAmount.toFixed(2)}) زائد مبلغ الضريبة (${declaredVatAmount.toFixed(2)}).`,
    resolutionEn: 'Calculate TaxInclusiveAmount as TaxExclusiveAmount + TaxAmount.',
    resolutionAr: 'احسب المبلغ الإجمالي بجمع صافي المبلغ مع قيمة ضريبة القيمة المضافة.',
    fineImpactSar: 5000
  });

  // 12. QR Code Inspection if present
  let tlvInspection: TlvInspection | undefined;
  const qrRef = Array.from(addRefs).find(r => getElementText(r, 'ID') === 'QR');
  if (qrRef) {
    const attachment = qrRef.getElementsByTagName('cac:Attachment').item(0) ||
                       qrRef.getElementsByTagName('Attachment').item(0);
    if (attachment) {
      const qrBase64 = getElementText(attachment, 'EmbeddedDocumentBinaryObject') || '';
      recordCheck(qrBase64.length > 0 && qrBase64.length <= 700, {
        code: 'BR-KSA-QR-LENGTH',
        severity: 'ERROR',
        category: 'CRYPTOGRAPHY',
        field: 'QR EmbeddedDocumentBinaryObject',
        messageEn: `QR code string length (${qrBase64.length} chars) exceeds the 700-character ZATCA limit.`,
        messageAr: `طول نص الـ QR كود (${qrBase64.length} حرفاً) يتجاوز الحد الأقصى المسموح به من هيئة الزكاة (700 حرف).`,
        resolutionEn: 'Ensure TLV QR Base64 string does not exceed 700 characters.',
        resolutionAr: 'تأكد من أن طول كود الاستجابة السريعة لا يتجاوز 700 محرف.',
        fineImpactSar: 5000
      });

      try {
        const qrBuffer = Buffer.from(qrBase64, 'base64');
        const parsedTlv: TlvEntry[] = parseTlvQrBuffer(qrBuffer);
        const tagMap = new Map<number, Buffer>(parsedTlv.map((t: TlvEntry) => [t.tag, t.value]));

        tlvInspection = {
          sellerName: tagMap.get(1)?.toString('utf8'),
          vatNumber: tagMap.get(2)?.toString('utf8'),
          timestamp: tagMap.get(3)?.toString('utf8'),
          invoiceTotal: tagMap.get(4)?.toString('utf8'),
          vatTotal: tagMap.get(5)?.toString('utf8'),
          hashPresent: tagMap.has(6),
          signaturePresent: tagMap.has(7),
          publicKeyPresent: tagMap.has(8),
          tagLengthsValid: parsedTlv.every((t: TlvEntry) => t.value.length <= 127),
          base64Length: qrBase64.length
        };

        recordCheck(tlvInspection.tagLengthsValid, {
          code: 'QRCODE_INVALID_BER_OVERFLOW',
          severity: 'ERROR',
          category: 'CRYPTOGRAPHY',
          messageEn: 'One or more TLV QR tags exceed 127 bytes, violating single-byte BER encoding.',
          messageAr: 'أحد حقول الـ QR كود تجاوز 127 بايت مما يخالف ترميز BER ويؤدي لرفض الفاتورة فورياً.',
          resolutionEn: 'Ensure all TLV values are 127 bytes or fewer.',
          resolutionAr: 'تأكد من أن أطوال الحقول لا تتجاوز 127 بايت لكل حقل.',
          fineImpactSar: 5000
        });

        if (tlvInspection.vatNumber && supplierVat) {
          recordCheck(tlvInspection.vatNumber === supplierVat, {
            code: 'BR-KSA-QR-VAT-MISMATCH',
            severity: 'ERROR',
            category: 'CRYPTOGRAPHY',
            messageEn: `QR VAT (${tlvInspection.vatNumber}) does not match Supplier VAT (${supplierVat}).`,
            messageAr: `الرقم الضريبي في الـ QR كود (${tlvInspection.vatNumber}) لا يطابق الرقم الضريبي للمورد بالفاتورة (${supplierVat}).`,
            resolutionEn: 'Ensure QR Tag 2 matches cbc:CompanyID.',
            resolutionAr: 'طابق الرقم الضريبي في رمز الاستجابة السريعة مع حقل المنشأة.',
            fineImpactSar: 5000
          });
        }
      } catch (err: any) {
        recordCheck(false, {
          code: 'QRCODE_INVALID',
          severity: 'ERROR',
          category: 'CRYPTOGRAPHY',
          messageEn: 'Malformed QR code TLV buffer: ' + err.message,
          messageAr: 'ترميز الـ QR كود تالف أو غير متوافق مع معيار TLV: ' + err.message,
          resolutionEn: 'Encode QR code following ZATCA Section 6 TLV structure.',
          resolutionAr: 'قم بترميز الـ QR كود وفق مواصفات هيئة الزكاة المعيارية TLV.',
          fineImpactSar: 5000
        });
      }
    }
  }

  const failedChecks = findings.filter(f => f.severity === 'ERROR').length;
  const warningChecks = findings.filter(f => f.severity === 'WARNING').length;
  const fineRiskSar = findings.reduce((acc, f) => acc + (f.fineImpactSar || 0), 0);
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

  return {
    valid: failedChecks === 0,
    documentType: docType,
    score,
    summary: {
      totalChecks,
      passedChecks,
      failedChecks,
      warningChecks,
      fineRiskSar
    },
    findings,
    tlvInspection
  };
}

export function validateSallaPayloadPreflight(sallaOrder: any): PreflightValidationResult {
  const findings: PreflightFinding[] = [];
  let totalChecks = 0;
  let passedChecks = 0;

  function recordCheck(passed: boolean, findingIfFailed: PreflightFinding) {
    totalChecks++;
    if (passed) {
      passedChecks++;
    } else {
      findings.push(findingIfFailed);
    }
  }

  recordCheck(sallaOrder && typeof sallaOrder.id === 'number', {
    code: 'SALLA-ORDER-ID-MISSING',
    severity: 'ERROR',
    category: 'SCHEMA',
    field: 'id',
    messageEn: 'Salla order ID is missing or invalid.',
    messageAr: 'رقم طلب سلة مفقود أو غير صالح.',
    resolutionEn: 'Verify webhook payload contains order.id.',
    resolutionAr: 'تأكد من احتواء الإشعار على رقم الطلب id.',
    fineImpactSar: 5000
  });

  const currency = sallaOrder?.currency || sallaOrder?.total?.currency;
  recordCheck(currency === 'SAR', {
    code: 'BR-KSA-25',
    severity: 'ERROR',
    category: 'BUSINESS_RULES',
    field: 'currency',
    messageEn: `Order currency must be SAR, received "${currency}".`,
    messageAr: `عملة الطلب يجب أن تكون بالريال السعودي (SAR)، المستلم: "${currency}".`,
    resolutionEn: 'Ensure Salla checkout is configured in SAR currency.',
    resolutionAr: 'تأكد من ضبط عملة المتجر في سلة إلى الريال السعودي.',
    fineImpactSar: 5000
  });

  const items = sallaOrder?.items || [];
  recordCheck(Array.isArray(items) && items.length > 0, {
    code: 'BR-KSA-LINES-EXIST',
    severity: 'ERROR',
    category: 'SCHEMA',
    field: 'items',
    messageEn: 'Order must contain at least one line item.',
    messageAr: 'الطلب يجب أن يحتوي على منتج أو خدمة واحدة على الأقل.',
    resolutionEn: 'Verify order contains line items before pushing to ZATCA.',
    resolutionAr: 'تأكد من وجود بنود في السلة قبل إصدار الفاتورة.',
    fineImpactSar: 5000
  });

  const failedChecks = findings.filter(f => f.severity === 'ERROR').length;
  const warningChecks = findings.filter(f => f.severity === 'WARNING').length;
  const fineRiskSar = findings.reduce((acc, f) => acc + (f.fineImpactSar || 0), 0);
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;

  return {
    valid: failedChecks === 0,
    documentType: 'Simplified',
    score,
    summary: {
      totalChecks,
      passedChecks,
      failedChecks,
      warningChecks,
      fineRiskSar
    },
    findings
  };
}
