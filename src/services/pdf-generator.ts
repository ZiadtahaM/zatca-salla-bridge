export interface InvoicePdfInput {
  invoiceId: string;
  uuid: string;
  icv: number;
  invoiceType: string;
  orderId: string;
  issueTimestamp: string;
  supplyDate: string;
  sellerNameArabic: string;
  sellerVat: string;
  subtotal: string;
  taxTotal: string;
  grandTotal: string;
  currency: string;
  qrCodeBase64: string;
  xmlContent: string;
  pih: string;
  invoiceHash: string;
  qrDataUrl?: string;
}

function escapePdfString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '')
    .replace(/\n/g, ' ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function resolveBilingualInvoiceTitle(invoiceType: string): string {
  switch (invoiceType) {
    case 'simplified_tax_invoice':
      return 'فاتورة ضريبية مبسطة / Simplified Tax Invoice';
    case 'tax_invoice':
      return 'فاتورة ضريبية / Tax Invoice';
    case 'credit_note':
      return 'إشعار دائن / Credit Note';
    case 'debit_note':
      return 'إشعار مدين / Debit Note';
    default:
      return 'فاتورة ضريبية مبسطة / Simplified Tax Invoice';
  }
}

export function generateZatcaPdfA3Buffer(input: InvoicePdfInput): Buffer {
  const xmlBuffer = Buffer.from(input.xmlContent, 'utf-8');
  const titleLabel = resolveBilingualInvoiceTitle(input.invoiceType);

  const lines = [
    `ZATCA Phase 2 Tax Invoice (PDF/A-3B)`,
    `Document Type: ${input.invoiceType} (${titleLabel})`,
    `Invoice ID: ${input.invoiceId}`,
    `Invoice UUID: ${input.uuid}`,
    `ICV: ${input.icv}`,
    `Order ID: ${input.orderId}`,
    `Seller Name: ${input.sellerNameArabic}`,
    `Seller VAT: ${input.sellerVat}`,
    `Issue Timestamp: ${input.issueTimestamp}`,
    `Supply Date: ${input.supplyDate}`,
    `Subtotal: ${input.subtotal} ${input.currency}`,
    `VAT 15%: ${input.taxTotal} ${input.currency}`,
    `Grand Total: ${input.grandTotal} ${input.currency}`,
    `PIH: ${input.pih}`,
    `Invoice Hash: ${input.invoiceHash}`,
    `QR TLV Base64: ${input.qrCodeBase64}`
  ];

  const textOps: string[] = ['BT', '/F1 10 Tf', '40 790 Td', '16 TL'];
  for (const line of lines) {
    textOps.push(`(${escapePdfString(line)}) Tj T*`);
  }
  textOps.push('ET');
  const contentStreamData = Buffer.from(textOps.join('\n'), 'utf-8');

  const chunks: Buffer[] = [];
  const offsets: number[] = [0]; // index 0 is free object entry
  let currentOffset = 0;

  const pushChunk = (buf: Buffer) => {
    chunks.push(buf);
    currentOffset += buf.length;
  };

  const pushString = (str: string) => {
    pushChunk(Buffer.from(str, 'utf-8'));
  };

  // PDF-1.7 Header with binary comment for PDF/A-3 conformance
  pushChunk(Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary'));

  // Object 1: Catalog with EmbeddedFiles and AF (Associated Files) array for PDF/A-3
  offsets.push(currentOffset);
  pushString(
    `1 0 obj\n` +
    `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(ZATCA_eInvoice.xml) 6 0 R] >> >> /AF [6 0 R] /MarkInfo << /Marked true >> >>\n` +
    `endobj\n`
  );

  // Object 2: Pages
  offsets.push(currentOffset);
  pushString(
    `2 0 obj\n` +
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n` +
    `endobj\n`
  );

  // Object 3: Page
  offsets.push(currentOffset);
  pushString(
    `3 0 obj\n` +
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /AF [6 0 R] >>\n` +
    `endobj\n`
  );

  // Object 4: Font
  offsets.push(currentOffset);
  pushString(
    `4 0 obj\n` +
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n` +
    `endobj\n`
  );

  // Object 5: Page Content Stream
  offsets.push(currentOffset);
  pushString(`5 0 obj\n<< /Length ${contentStreamData.length} >>\nstream\n`);
  pushChunk(contentStreamData);
  pushString(`\nendstream\nendobj\n`);

  // Object 6: Filespec for ZATCA_eInvoice.xml with /AFRelationship /Alternative
  offsets.push(currentOffset);
  pushString(
    `6 0 obj\n` +
    `<< /Type /Filespec /F (ZATCA_eInvoice.xml) /UF (ZATCA_eInvoice.xml) /Desc (ZATCA Phase 2 Signed UBL 2.1 XML Invoice) /AFRelationship /Alternative /EF << /F 7 0 R /UF 7 0 R >> >>\n` +
    `endobj\n`
  );

  // Object 7: EmbeddedFile stream containing UTF-8 XML bytes
  offsets.push(currentOffset);
  pushString(
    `7 0 obj\n` +
    `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Params << /Size ${xmlBuffer.length} >> /Length ${xmlBuffer.length} >>\n` +
    `stream\n`
  );
  pushChunk(xmlBuffer);
  pushString(`\nendstream\nendobj\n`);

  // Cross-reference table
  const xrefOffset = currentOffset;
  const totalObjects = offsets.length;
  let xrefTable = `xref\n0 ${totalObjects}\n0000000000 65535 f \n`;
  for (let i = 1; i < totalObjects; i++) {
    const paddedOffset = offsets[i].toString().padStart(10, '0');
    xrefTable += `${paddedOffset} 00000 n \n`;
  }
  pushString(xrefTable);

  // Trailer
  pushString(
    `trailer\n` +
    `<< /Size ${totalObjects} /Root 1 0 R >>\n` +
    `startxref\n` +
    `${xrefOffset}\n` +
    `%%EOF\n`
  );

  return Buffer.concat(chunks);
}

export function generateBilingualPrintableHtml(input: InvoicePdfInput): string {
  const titleBilingual = resolveBilingualInvoiceTitle(input.invoiceType);
  const xmlBase64 = Buffer.from(input.xmlContent, 'utf-8').toString('base64');
  const currency = input.currency || 'SAR';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(titleBilingual)} - ${escapeHtml(input.uuid)}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #e2e8f0;
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .invoice-container {
      max-width: 860px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid var(--accent);
      padding-bottom: 16px;
      margin-bottom: 24px;
    }
    .invoice-type-badge {
      display: inline-block;
      background: #f0fdfa;
      color: var(--accent);
      border: 1px solid #99f6e4;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 1.05rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .box {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
    }
    .box-label {
      font-size: 0.85rem;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .box-value {
      font-weight: 600;
      word-break: break-all;
    }
    .ltr {
      direction: ltr;
      text-align: left;
      font-family: monospace;
    }
    table.financial-summary {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    table.financial-summary th,
    table.financial-summary td {
      border: 1px solid var(--border);
      padding: 12px;
      text-align: right;
    }
    table.financial-summary th {
      background: #f1f5f9;
    }
    .grand-total-row {
      font-weight: 700;
      background: #f0fdfa;
    }
    .crypto-stamp {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      background: #f8fafc;
    }
    .download-xml {
      display: inline-block;
      margin-top: 12px;
      padding: 8px 14px;
      background: var(--accent);
      color: #ffffff;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .invoice-container { border: none; padding: 0; }
    }
  </style>
</head>
<body>
  <main class="invoice-container">
    <header class="header">
      <div>
        <div class="invoice-type-badge">${escapeHtml(titleBilingual)}</div>
        <h1>${escapeHtml(input.sellerNameArabic)}</h1>
        <p>الرقم الضريبي للمورد / Seller VAT: <span class="ltr">${escapeHtml(input.sellerVat)}</span></p>
      </div>
      <div style="display: flex; gap: 16px; align-items: center;">
        ${input.qrDataUrl ? `<img src="${input.qrDataUrl}" alt="ZATCA QR Code" style="width: 100px; height: 100px; border: 1px solid var(--border); border-radius: 6px; padding: 4px; background: white;" />` : ''}
        <div class="ltr">
          <div><strong>Order ID:</strong> ${escapeHtml(input.orderId)}</div>
          <div><strong>ICV:</strong> ${escapeHtml(String(input.icv))}</div>
          <div><strong>Issue Timestamp:</strong> ${escapeHtml(input.issueTimestamp)}</div>
          <div><strong>Supply Date:</strong> ${escapeHtml(input.supplyDate)}</div>
        </div>
      </div>
    </header>

    <section class="grid">
      <div class="box">
        <div class="box-label">معرف الفاتورة العالمي / Invoice UUID</div>
        <div class="box-value ltr">${escapeHtml(input.uuid)}</div>
      </div>
      <div class="box">
        <div class="box-label">عداد الفاتورة / Invoice Counter Value (ICV)</div>
        <div class="box-value ltr">${escapeHtml(String(input.icv))}</div>
      </div>
      <div class="box">
        <div class="box-label">رقم الطلب / Order ID</div>
        <div class="box-value ltr">${escapeHtml(input.orderId)}</div>
      </div>
      <div class="box">
        <div class="box-label">تاريخ ووقت الإصدار / Issue Timestamp</div>
        <div class="box-value ltr">${escapeHtml(input.issueTimestamp)}</div>
      </div>
    </section>

    <section>
      <h2>الملخص المالي / Financial Summary</h2>
      <table class="financial-summary">
        <thead>
          <tr>
            <th>البيان / Description</th>
            <th>المبلغ / Amount (${escapeHtml(currency)})</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>المجموع الفرعي (غير شامل الضريبة) / Subtotal</td>
            <td class="ltr">${escapeHtml(input.subtotal)} ${escapeHtml(currency)}</td>
          </tr>
          <tr>
            <td>ضريبة القيمة المضافة (15%) / VAT 15%</td>
            <td class="ltr">${escapeHtml(input.taxTotal)} ${escapeHtml(currency)}</td>
          </tr>
          <tr class="grand-total-row">
            <td>الإجمالي شامل الضريبة / Grand Total</td>
            <td class="ltr">${escapeHtml(input.grandTotal)} ${escapeHtml(currency)}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="crypto-stamp">
      <h2>الختم الرقمي لهيئة الزكاة والضريبة والجمارك / ZATCA Cryptographic Stamp</h2>
      <div class="box-label">تجزئة الفاتورة / Invoice Hash (SHA-256)</div>
      <div class="box-value ltr">${escapeHtml(input.invoiceHash)}</div>
      <div class="box-label" style="margin-top:10px;">تجزئة الفاتورة السابقة / Previous Invoice Hash (PIH)</div>
      <div class="box-value ltr">${escapeHtml(input.pih)}</div>
      <div class="box-label" style="margin-top:10px;">حمولة رمز الاستجابة السريعة / TLV QR Base64 Payload</div>
      <div class="box-value ltr">${escapeHtml(input.qrCodeBase64)}</div>
      <div>
        <a class="download-xml" download="ZATCA_eInvoice_${escapeHtml(input.uuid)}.xml" href="data:application/xml;base64,${xmlBase64}">
          تحميل ملف XML المدمج / Download Embedded ZATCA XML
        </a>
      </div>
    </section>
  </main>
</body>
</html>`;
}
