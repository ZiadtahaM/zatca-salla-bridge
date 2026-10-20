import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { validateZatcaPreflight } from '../services/zatca-preflight.js';

interface PreflightBody {
  content: string;
  format?: 'xml' | 'salla_json';
}

export const validatorRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Preflight validation API endpoint
  app.post<{ Body: PreflightBody }>('/api/validate/preflight', async (request, reply) => {
    const { content, format } = request.body || {};

    if (!content || typeof content !== 'string') {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: 'content field is required and must be a string'
      });
    }

    const result = validateZatcaPreflight(content, format || 'xml');
    return reply.status(200).send(result);
  });

  // Self-contained Pre-Flight Debugger Web Interface
  app.get('/debugger', async (_request, reply) => {
    const html = getDebuggerHtml();
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  });
};

function getDebuggerHtml(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>فاحص الفواتير الاستباقي | ZATCA Phase 2 Pre-Flight Debugger</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --border: #1f2937;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #10b981;
      --primary-hover: #059669;
      --danger: #ef4444;
      --warning: #f59e0b;
      --info: #3b82f6;
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-family);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand h1 { font-size: 22px; font-weight: 700; color: #fff; }
    .badge {
      background: rgba(16, 185, 129, 0.1);
      color: var(--primary);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
    }
    .lang-toggle {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 868px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    textarea {
      width: 100%;
      height: 380px;
      background: #030712;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      color: #e5e7eb;
      font-family: monospace;
      font-size: 13px;
      resize: vertical;
    }
    textarea:focus { outline: none; border-color: var(--primary); }
    .toolbar {
      display: flex;
      gap: 10px;
      margin-top: 14px;
      align-items: center;
    }
    button.btn-primary {
      background: var(--primary);
      color: #000;
      border: none;
      padding: 10px 24px;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.15s ease;
    }
    button.btn-primary:hover { background: var(--primary-hover); }
    button.btn-secondary {
      background: #1f2937;
      color: #d1d5db;
      border: 1px solid #374151;
      padding: 10px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
    }
    button.btn-secondary:hover { background: #374151; }
    .stat-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-box {
      background: #030712;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }
    .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
    .stat-val { font-size: 22px; font-weight: 700; }
    .val-pass { color: var(--primary); }
    .val-danger { color: var(--danger); }
    .findings-list {
      max-height: 480px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .finding-item {
      background: #030712;
      border: 1px solid var(--border);
      border-right: 4px solid var(--danger);
      border-radius: 8px;
      padding: 14px;
    }
    .finding-item.pass {
      border-right-color: var(--primary);
    }
    .finding-code {
      font-family: monospace;
      font-size: 12px;
      font-weight: 700;
      color: #93c5fd;
      display: inline-block;
      margin-bottom: 4px;
    }
    .finding-msg { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .finding-res { font-size: 12px; color: var(--text-muted); }
    .fine-tag {
      display: inline-block;
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 4px;
      margin-top: 6px;
      font-weight: 600;
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>فاحص الفواتير الاستباقي (ZATCA Pre-Flight Debugger)</h1>
        <span class="badge">Wave 24 & 25 Ready</span>
      </div>
      <button class="lang-toggle" onclick="toggleLanguage()">English / عربي</button>
    </header>

    <div class="stat-bar" id="statBar" style="display: none;">
      <div class="stat-box">
        <div class="stat-label" id="lblScore">نسبة المطابقة</div>
        <div class="stat-val" id="statScore">0%</div>
      </div>
      <div class="stat-box">
        <div class="stat-label" id="lblDocType">نوع المستند</div>
        <div class="stat-val" id="statDocType" style="font-size: 16px;">-</div>
      </div>
      <div class="stat-box">
        <div class="stat-label" id="lblErrors">الأخطاء القاطعة</div>
        <div class="stat-val val-danger" id="statErrors">0</div>
      </div>
      <div class="stat-box">
        <div class="stat-label" id="lblFineRisk">مخاطر الغرامات المتوقعة</div>
        <div class="stat-val val-danger" id="statFineRisk">0 ر.س</div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="card-title">
          <span id="txtInputTitle">محتوى ملف الفاتورة (XML أو Salla JSON)</span>
          <select id="formatSelect" style="background:#030712; color:#fff; border:1px solid var(--border); padding:4px 8px; border-radius:6px;">
            <option value="xml">UBL 2.1 XML</option>
            <option value="salla_json">Salla Order JSON</option>
          </select>
        </div>
        <textarea id="invoiceInput" placeholder="الصق كود الـ XML أو طلب سلة هنا..."></textarea>
        <div class="toolbar">
          <button class="btn-primary" onclick="runValidation()" id="btnAudit">فحص الفاتورة الآن</button>
          <button class="btn-secondary" onclick="loadSample('valid_xml')">عينة XML مطابقة</button>
          <button class="btn-secondary" onclick="loadSample('invalid_vat')">عينة خطأ ضريبي</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span id="txtReportTitle">تقرير الامتثال والتحليل الجنائي</span>
          <span id="reportStatus" class="badge" style="display:none;">جاهز</span>
        </div>
        <div id="reportContainer">
          <div class="empty-state" id="emptyPlaceholder">
            قم بلصق محتوى الفاتورة واضغط على "فحص الفاتورة الآن" لعرض فحص المعايير ومخاطر الغرامات.
          </div>
          <div class="findings-list" id="findingsList" style="display: none;"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentLang = 'ar';

    function toggleLanguage() {
      currentLang = currentLang === 'ar' ? 'en' : 'ar';
      document.documentElement.lang = currentLang;
      document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';

      document.getElementById('lblScore').innerText = currentLang === 'ar' ? 'نسبة المطابقة' : 'Compliance Score';
      document.getElementById('lblDocType').innerText = currentLang === 'ar' ? 'نوع المستند' : 'Document Type';
      document.getElementById('lblErrors').innerText = currentLang === 'ar' ? 'الأخطاء القاطعة' : 'Fatal Errors';
      document.getElementById('lblFineRisk').innerText = currentLang === 'ar' ? 'مخاطر الغرامات' : 'Fine Risk SAR';
      document.getElementById('txtInputTitle').innerText = currentLang === 'ar' ? 'محتوى ملف الفاتورة' : 'Invoice Content (XML / JSON)';
      document.getElementById('txtReportTitle').innerText = currentLang === 'ar' ? 'تقرير الامتثال والتحليل الجنائي' : 'Compliance Audit Report';
      document.getElementById('btnAudit').innerText = currentLang === 'ar' ? 'فحص الفاتورة الآن' : 'Audit Invoice Now';
    }

    async function runValidation() {
      const content = document.getElementById('invoiceInput').value.trim();
      const format = document.getElementById('formatSelect').value;
      if (!content) {
        alert(currentLang === 'ar' ? 'يرجى إدخال محتوى الفاتورة أولاً' : 'Please paste invoice content first');
        return;
      }

      try {
        const response = await fetch('/api/validate/preflight', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, format })
        });
        const data = await response.json();
        renderReport(data);
      } catch (err) {
        alert('Validation request failed: ' + err.message);
      }
    }

    function renderReport(data) {
      document.getElementById('statBar').style.display = 'grid';
      document.getElementById('emptyPlaceholder').style.display = 'none';
      const findingsList = document.getElementById('findingsList');
      findingsList.style.display = 'flex';
      findingsList.innerHTML = '';

      document.getElementById('statScore').innerText = data.score + '%';
      document.getElementById('statScore').className = 'stat-val ' + (data.score >= 90 ? 'val-pass' : 'val-danger');
      document.getElementById('statDocType').innerText = data.documentType;
      document.getElementById('statErrors').innerText = data.summary.failedChecks;
      document.getElementById('statFineRisk').innerText = data.summary.fineRiskSar.toLocaleString() + ' SAR';

      const statusBadge = document.getElementById('reportStatus');
      statusBadge.style.display = 'inline-block';
      statusBadge.innerText = data.valid ? (currentLang === 'ar' ? 'مطابقة 100%' : 'Compliant') : (currentLang === 'ar' ? 'تحتوي على مخالفات' : 'Violations Found');
      statusBadge.style.color = data.valid ? '#10b981' : '#ef4444';
      statusBadge.style.borderColor = data.valid ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)';

      if (data.findings.length === 0) {
        findingsList.innerHTML = '<div class="finding-item pass"><div class="finding-msg" style="color:#10b981;">' +
          (currentLang === 'ar' ? 'تم الفحص بنجاح! الفاتورة مطابقة لجميع متطلبات هيئة الزكاة والضريبة والجمارك.' : 'Full Pass! Invoice meets all ZATCA Phase 2 specifications.') +
          '</div></div>';
        return;
      }

      data.findings.forEach(f => {
        const item = document.createElement('div');
        item.className = 'finding-item';
        const msg = currentLang === 'ar' ? f.messageAr : f.messageEn;
        const res = currentLang === 'ar' ? f.resolutionAr : f.resolutionEn;
        const fineTag = f.fineImpactSar ? '<span class="fine-tag">' + (currentLang === 'ar' ? 'خطر غرامة: ' : 'Fine Risk: ') + f.fineImpactSar + ' SAR</span>' : '';

        item.innerHTML = '<span class="finding-code">' + f.code + '</span>' +
          '<div class="finding-msg">' + msg + '</div>' +
          '<div class="finding-res">' + res + '</div>' +
          fineTag;
        findingsList.appendChild(item);
      });
    }

    function loadSample(type) {
      if (type === 'valid_xml') {
        document.getElementById('formatSelect').value = 'xml';
        document.getElementById('invoiceInput').value = \`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-2026-0001</cbc:ID>
  <cbc:UUID>123e4567-e89b-12d3-a456-426614174000</cbc:UUID>
  <cbc:IssueDate>2026-10-20</cbc:IssueDate>
  <cbc:IssueTime>14:30:00</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>1</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">NWZlY2ViNjAxOTE1OTQyM2NmMzZguMzJkNWQxNjQ3MzI=</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>King Fahd Road</cbc:StreetName>
        <cbc:BuildingNumber>1234</cbc:BuildingNumber>
        <cbc:CityName>Riyadh</cbc:CityName>
        <cbc:PostalZone>12345</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>310123456700003</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>متجر الاختبار المعتمد</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">115.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">115.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">1.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>عطر شرقي فاخر</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>\`;
      } else if (type === 'invalid_vat') {
        document.getElementById('formatSelect').value = 'xml';
        document.getElementById('invoiceInput').value = \`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>INV-2026-0002</cbc:ID>
  <cbc:UUID>123e4567-e89b-12d3-a456-426614174000</cbc:UUID>
  <cbc:IssueDate>2026-10-20</cbc:IssueDate>
  <cbc:IssueTime>14:30:00</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>USD</cbc:TaxCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:StreetName>King Fahd Road</cbc:StreetName>
        <cbc:BuildingNumber>12</cbc:BuildingNumber>
        <cbc:CityName>Riyadh</cbc:CityName>
        <cbc:PostalZone>123</cbc:PostalZone>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>123456789</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">15.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">130.00</cbc:TaxInclusiveAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:LineExtensionAmount currencyID="SAR">100.00</cbc:LineExtensionAmount>
  </cac:InvoiceLine>
</Invoice>\`;
      }
    }
  </script>
</body>
</html>`;
}
