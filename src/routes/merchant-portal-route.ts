import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { pool } from '../storage/db.js';
import { submitInvoiceToFatoora } from '../services/fatoora-dispatcher.js';
import { processPartialCreditNote } from '../services/invoice-generator.js';

export const merchantPortalRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/portal', async (request, reply) => {
    const query = (request.query || {}) as { merchantId?: string; merchant?: string; tab?: string };
    const merchantId = (query.merchantId || query.merchant || '').toString().trim();

    let storeTokens = null;
    let subscription = null;
    let egsUnits: any[] = [];
    let pendingB2b: any[] = [];
    let invoices: any[] = [];
    let dlqItems: any[] = [];

    if (merchantId) {
      const client = await pool.connect();
      try {
        const tokenRes = await client.query(
          `SELECT merchant_id, expires_at, store_name, vat_number, crn, city
           FROM merchant_tokens
           WHERE merchant_id = $1`,
          [merchantId]
        );
        if (tokenRes.rows.length > 0) {
          storeTokens = tokenRes.rows[0];
        }

        const subRes = await client.query(
          `SELECT plan_name, status, expires_at
           FROM merchant_subscriptions
           WHERE merchant_id = $1`,
          [merchantId]
        );
        if (subRes.rows.length > 0) {
          subscription = subRes.rows[0];
        }

        const egsRes = await client.query(
          `SELECT id, custom_id, branch_id, csid_environment, expires_at, renewal_status,
                  current_icv, last_document_hash, is_active
           FROM egs_units
           WHERE merchant_id = $1
           ORDER BY created_at DESC`,
          [merchantId]
        );
        egsUnits = egsRes.rows;

        const b2bRes = await client.query(
          `SELECT id, order_id, buyer_name, buyer_vat, missing_fields, created_at
           FROM pending_b2b_orders
           WHERE merchant_id = $1 AND status = 'pending_enrichment'
           ORDER BY created_at DESC`,
          [merchantId]
        );
        pendingB2b = b2bRes.rows;

        const invRes = await client.query(
          `SELECT i.id, i.uuid, i.order_id, i.invoice_type, i.grand_total, i.currency,
                  i.status, i.issue_timestamp, i.invoice_hash
           FROM invoices i
           JOIN egs_units u ON i.egs_unit_id = u.id
           WHERE u.merchant_id = $1
           ORDER BY i.issue_timestamp DESC
           LIMIT 50`,
          [merchantId]
        );
        invoices = invRes.rows;

        const dlqRes = await client.query(
          `SELECT id, invoice_id, failure_reason, http_status, attempt_count,
                  first_failed_at, last_failed_at, is_stalled, next_retry_at
           FROM zatca_dlq
           WHERE merchant_id = $1 AND resolved_at IS NULL
           ORDER BY first_failed_at DESC`,
          [merchantId]
        );
        dlqItems = dlqRes.rows;
      } finally {
        client.release();
      }
    }

    const html = renderPortalHtml({
      merchantId,
      storeTokens,
      subscription,
      egsUnits,
      pendingB2b,
      invoices,
      dlqItems,
      activeTab: query.tab || 'activation'
    });

    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  });

  app.post('/api/invoices/:id/dispatch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const client = await pool.connect();
    try {
      const result = await submitInvoiceToFatoora(client, id);
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(500).send({
        error: 'DISPATCH_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });

  app.post('/api/invoices/:id/partial-credit-note', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};
    const refundAmount = Number(body.refundAmount);
    const returnReason = body.returnReason || 'Partial Return / إشعار دائن جزئي';

    if (!refundAmount || isNaN(refundAmount) || refundAmount <= 0) {
      return reply.status(400).send({
        error: 'INVALID_AMOUNT',
        message: 'A valid positive refundAmount is required'
      });
    }

    const client = await pool.connect();
    try {
      const invRes = await client.query(
        `SELECT id, egs_unit_id, uuid, grand_total, status 
         FROM invoices 
         WHERE id = $1 OR uuid = $1 
         LIMIT 1`,
        [id]
      );

      if (invRes.rows.length === 0) {
        return reply.status(404).send({
          error: 'INVOICE_NOT_FOUND',
          message: `Invoice ${id} not found`
        });
      }

      const inv = invRes.rows[0];
      const result = await processPartialCreditNote(client, inv.egs_unit_id, {
        originalInvoiceId: inv.id,
        refundAmount,
        returnReason,
        items: body.items
      });

      return reply.status(200).send({
        success: true,
        creditNote: result
      });
    } catch (err: any) {
      return reply.status(400).send({
        error: 'CREDIT_NOTE_FAILED',
        message: err.message
      });
    } finally {
      client.release();
    }
  });
};

function renderPortalHtml(data: {
  merchantId: string;
  storeTokens: any;
  subscription: any;
  egsUnits: any[];
  pendingB2b: any[];
  invoices: any[];
  dlqItems: any[];
  activeTab: string;
}): string {
  const m = data.merchantId;
  const store = data.storeTokens || {};
  const sub = data.subscription || { plan_name: 'standard', status: 'active' };
  const primaryUnit = data.egsUnits[0];

  const hasActiveEgs = Boolean(primaryUnit && primaryUnit.is_active);
  const defaultStoreName = store.store_name || '';
  const defaultVat = store.vat_number || '';
  const defaultCity = store.city || 'الرياض';

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>بوابة التاجر الذاتية | ZATCA Phase 2 Salla Self-Service Portal</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-sub: #1f2937;
      --border: #374151;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --primary: #10b981;
      --primary-hover: #059669;
      --danger: #ef4444;
      --warning: #f59e0b;
      --info: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 24px; direction: rtl; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 24px; }
    .brand h1 { font-size: 1.5rem; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .brand p { color: var(--text-muted); font-size: 0.875rem; margin-top: 4px; }
    .merchant-meta { display: flex; gap: 12px; align-items: center; }
    .badge { padding: 4px 10px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
    .badge-success { background: rgba(16, 185, 129, 0.2); color: var(--primary); border: 1px solid var(--primary); }
    .badge-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); border: 1px solid var(--warning); }
    .badge-danger { background: rgba(239, 68, 68, 0.2); color: var(--danger); border: 1px solid var(--danger); }
    .badge-info { background: rgba(59, 130, 246, 0.2); color: var(--info); border: 1px solid var(--info); }
    
    .nav-tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border); margin-bottom: 24px; overflow-x: auto; }
    .tab-btn { background: none; border: none; color: var(--text-muted); padding: 12px 18px; font-size: 0.95rem; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; white-space: nowrap; }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    .card-title { font-size: 1.15rem; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }

    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }

    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 6px; }
    .form-control { width: 100%; background: var(--card-sub); border: 1px solid var(--border); color: var(--text); padding: 10px 14px; border-radius: 6px; font-size: 0.9rem; }
    .form-control:focus { outline: none; border-color: var(--primary); }

    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 18px; border-radius: 6px; font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none; transition: 0.2s; text-decoration: none; }
    .btn-primary { background: var(--primary); color: #000; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: var(--card-sub); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); }
    .btn-sm { padding: 6px 12px; font-size: 0.8rem; }

    table { width: 100%; border-collapse: collapse; text-align: right; }
    th { padding: 12px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 0.8rem; }
    td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 0.875rem; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }

    .empty-state { text-align: center; padding: 40px; color: var(--text-muted); }
    .alert-box { padding: 14px; border-radius: 6px; margin-bottom: 16px; font-size: 0.9rem; }
    .alert-success { background: rgba(16, 185, 129, 0.1); border: 1px solid var(--primary); color: var(--primary); }
    .alert-danger { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); color: var(--danger); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>لوحة تحكم التاجر الذاتية | ZATCA Phase 2 Portal</h1>
        <p>الربط المؤتمت الكامل بين متجر سلة ومنظومة الفاتورة الإلكترونية السعودية (المرحلة الثانية)</p>
      </div>
      <div class="merchant-meta">
        ${m ? `<span class="badge badge-info">المتجر: ${escapeHtml(m)}</span>` : `<span class="badge badge-warning">لم يتم تحديد المتجر</span>`}
        <span class="badge badge-success">الاشتراك: ${escapeHtml(sub.status)}</span>
      </div>
    </header>

    <div class="nav-tabs">
      <button class="tab-btn active" onclick="switchTab('activation')">1. التفعيل الفوري (1-Click ZATCA)</button>
      <button class="tab-btn" onclick="switchTab('b2b')">2. طابور فواتير الشركات B2B (${data.pendingB2b.length})</button>
      <button class="tab-btn" onclick="switchTab('invoices')">3. سجل الفواتير (${data.invoices.length})</button>
      <button class="tab-btn" onclick="switchTab('health')">4. صحة الختم والـ DLQ (${data.dlqItems.length})</button>
    </div>

    <!-- Tab 1: Activation -->
    <div id="tab-activation" class="tab-content active">
      <div class="grid-2">
        <div class="card">
          <h2 class="card-title">بيانات الربط مع هيئة الزكاة والضريبة والجمارك</h2>
          <div id="activation-alert" style="display: none;"></div>
          <form id="onboard-form" onsubmit="handleOnboard(event)">
            <input type="hidden" name="merchantId" value="${escapeHtml(m || 'salla_merch_01')}">
            <div class="form-group">
              <label>رمز التحقق (OTP) من بوابة فاتورة (صالح لمدة ساعة واحدة):</label>
              <input type="text" name="otp" class="form-control" placeholder="123456" maxlength="6" required>
            </div>
            <div class="form-group">
              <label>بيئة التشغيل (ZATCA Environment):</label>
              <select name="environment" class="form-control">
                <option value="simulation">محاكاة وهيئة التجربة (Simulation - PREZATCA)</option>
                <option value="production">الإنتاج الحي الحقيقي (Production - Core)</option>
                <option value="sandbox">بوابة المطورين (Developer Sandbox)</option>
              </select>
            </div>
            <div class="form-group">
              <label>اسم المنشأة التجاري (Organization Name):</label>
              <input type="text" name="storeName" class="form-control" value="${escapeHtml(defaultStoreName || 'متجر سلة المعتمد')}" required>
            </div>
            <div class="form-group">
              <label>الرقم الضريبي الموحد للمنشأة (15 رقم يبدأ وينتهي بـ 3):</label>
              <input type="text" name="vatNumber" class="form-control" value="${escapeHtml(defaultVat || '310123456700003')}" required>
            </div>
            <div class="form-group">
              <label>معرف الفرع أو نقطة البيع (Branch Identifier):</label>
              <input type="text" name="branchId" class="form-control" value="riyadh_hq" required>
            </div>
            <button type="submit" class="btn btn-primary" style="width: 100%;">
              ربط واعتماد الختم الرقمي فوراً مع ZATCA
            </button>
          </form>
        </div>

        <div class="card">
          <h2 class="card-title">حالة الربط والشهادة الرقمية الحالية</h2>
          ${primaryUnit ? `
            <div style="line-height: 2;">
              <p><strong>الحالة:</strong> <span class="badge badge-success">معتمد ونشط</span></p>
              <p><strong>معرف وحدة الختم (EGS ID):</strong> <code>${primaryUnit.id}</code></p>
              <p><strong>البيئة:</strong> <span class="badge badge-info">${primaryUnit.csid_environment}</span></p>
              <p><strong>عداد الفواتير التسلسلي (ICV):</strong> <code>${primaryUnit.current_icv}</code></p>
              <p><strong>صلاحية الشهادة تنتهي في:</strong> <code>${new Date(primaryUnit.expires_at).toLocaleDateString('ar-SA')}</code></p>
              <p><strong>آخر هاش مسجل (PIH):</strong> <code style="word-break: break-all; font-size: 0.75rem;">${primaryUnit.last_document_hash}</code></p>
            </div>
          ` : `
            <div class="empty-state">
              <p>لا توجد وحدة EGS مرتبطة حالياً لهذا المتجر.</p>
              <p style="margin-top: 8px; font-size: 0.85rem;">أدخل رمز OTP من منصة فاتورة واضغط على زر الربط لتفعيل إصدار الفواتير فوراً.</p>
            </div>
          `}
        </div>
      </div>
    </div>

    <!-- Tab 2: Held B2B Queue -->
    <div id="tab-b2b" class="tab-content">
      <div class="card">
        <h2 class="card-title">فواتير الشركات المعلقة (بانتظار استكمال العنوان الوطني)</h2>
        <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 16px;">
          تتطلب هيئة الزكاة اكتمال العنوان الوطني للمشتري (رقم المبنى المكون من 4 أرقام والرمز البريدي). يتم حجز الفاتورة هنا لحماية تسلسل الـ ICV.
        </p>
        ${data.pendingB2b.length > 0 ? `
          <table>
            <thead>
              <tr>
                <th>رقم الطلب</th>
                <th>اسم المشتري / المنشأة</th>
                <th>الرقم الضريبي</th>
                <th>الحقول الناقصة</th>
                <th>تاريخ الطلب</th>
                <th>الإجراء</th>
              </tr>
            </thead>
            <tbody>
              ${data.pendingB2b.map(item => `
                <tr>
                  <td><code>${item.order_id}</code></td>
                  <td>${escapeHtml(item.buyer_name)}</td>
                  <td><code>${item.buyer_vat}</code></td>
                  <td><span class="badge badge-warning">${escapeHtml(Array.isArray(item.missing_fields) ? item.missing_fields.join(', ') : 'العنوان الوطني')}</span></td>
                  <td>${new Date(item.created_at).toLocaleString('ar-SA')}</td>
                  <td>
                    <button class="btn btn-secondary btn-sm" onclick="openEnrichModal('${item.order_id}')">
                      استكمال وتوقيع
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : `
          <div class="empty-state">
            <p>ممتاز! لا توجد أي فواتير شركات معلقة حالياً.</p>
          </div>
        `}
      </div>
    </div>

    <!-- Tab 3: Invoices -->
    <div id="tab-invoices" class="tab-content">
      <div class="card">
        <h2 class="card-title">سجل الفواتير المصدرة</h2>
        ${data.invoices.length > 0 ? `
          <table>
            <thead>
              <tr>
                <th>معرف الفاتورة (UUID)</th>
                <th>رقم الطلب</th>
                <th>النوع</th>
                <th>المبلغ الإجمالي</th>
                <th>حالة ZATCA</th>
                <th>التاريخ</th>
                <th>التحميل والمعاينة</th>
              </tr>
            </thead>
            <tbody>
              ${data.invoices.map(inv => `
                <tr>
                  <td><code style="font-size: 0.75rem;">${inv.uuid.slice(0, 8)}...</code></td>
                  <td><code>${inv.order_id}</code></td>
                  <td>${inv.invoice_type === 'tax_invoice' ? '<span class="badge badge-info">ضريبية B2B</span>' : (inv.invoice_type === 'credit_note' ? '<span class="badge badge-warning">إشعار دائن</span>' : '<span class="badge badge-success">مبسطة B2C</span>')}</td>
                  <td><strong>${inv.grand_total} ${inv.currency}</strong></td>
                  <td><span class="badge ${inv.status === 'cleared' || inv.status === 'reported' ? 'badge-success' : (inv.status === 'rejected' ? 'badge-danger' : 'badge-warning')}">${inv.status}</span></td>
                  <td>${new Date(inv.issue_timestamp).toLocaleDateString('ar-SA')}</td>
                  <td>
                    <a href="/api/invoices/${inv.id}/pdf" target="_blank" class="btn btn-secondary btn-sm">PDF/A-3</a>
                    <a href="/api/invoices/${inv.id}/printable" target="_blank" class="btn btn-secondary btn-sm">عرض</a>
                    <button class="btn btn-primary btn-sm" onclick="dispatchInvoice('${inv.id}')">إرسال لهيئة الزكاة</button>
                    ${inv.invoice_type !== 'credit_note' ? `<button class="btn btn-warning btn-sm" onclick="openPartialCreditModal('${inv.id}', '${inv.uuid}', ${inv.grand_total})">إشعار دائن (381)</button>` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : `
          <div class="empty-state">
            <p>لم يتم تسجيل أي فواتير بعد لهذا المتجر.</p>
          </div>
        `}
      </div>
    </div>

    <!-- Tab 4: Health, CSID Renewal & DLQ -->
    <div id="tab-health" class="tab-content">
      <div class="grid-2">
        <div class="card">
          <h2 class="card-title">تجديد الختم الرقمي (CSID Renewal)</h2>
          <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 14px;">
            تجديد الشهادة قبل انتهائها مع الحفاظ التام على تسلسل الفواتير الـ ICV وسلسلة الهاش دون انقطاع.
          </p>
          ${primaryUnit ? `
            <form onsubmit="handleRenew(event, '${primaryUnit.id}')">
              <div class="form-group">
                <label>رمز التحقق (OTP) الجديد من منصة فاتورة:</label>
                <input type="text" id="renew-otp" class="form-control" placeholder="6 أرقام" maxlength="6" required>
              </div>
              <button type="submit" class="btn btn-primary" style="width: 100%;">
                تجديد الختم الرقمي فوراً دون تصفير العداد
              </button>
            </form>
          ` : `
            <p class="empty-state">يرجى إتمام الربط الأولي أولاً.</p>
          `}
        </div>

        <div class="card">
          <h2 class="card-title">طابور إعادة المحاولة عند انقطاع الشبكة (DLQ)</h2>
          ${data.dlqItems.length > 0 ? `
            <table>
              <thead>
                <tr>
                  <th>السبب</th>
                  <th>المحاولات</th>
                  <th>الحالة</th>
                  <th>الإجراء</th>
                </tr>
              </thead>
              <tbody>
                ${data.dlqItems.map(d => `
                  <tr>
                    <td style="font-size: 0.75rem;">${escapeHtml(d.failure_reason.slice(0, 40))}...</td>
                    <td><code>${d.attempt_count}</code></td>
                    <td><span class="badge ${d.is_stalled ? 'badge-danger' : 'badge-warning'}">${d.is_stalled ? 'معلق > 30 دقيقة' : 'إعادة مجدولة'}</span></td>
                    <td>
                      <button class="btn btn-secondary btn-sm" onclick="dispatchInvoice('${d.invoice_id}')">إعادة فورية</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : `
            <div class="empty-state">
              <p>طابور DLQ فارغ 100%. جميع الفواتير مرسلة بنجاح ودون أي تعليق.</p>
            </div>
          `}
        </div>
      </div>
    </div>
  </div>

  <script>
    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      const target = document.getElementById('tab-' + tabId);
      if (target) target.classList.add('active');
      event.target.classList.add('active');
    }

    async function handleOnboard(e) {
      e.preventDefault();
      const form = e.target;
      const formData = new FormData(form);
      const payload = {
        merchantId: formData.get('merchantId'),
        branchId: formData.get('branchId'),
        storeName: formData.get('storeName'),
        vatNumber: formData.get('vatNumber'),
        otp: formData.get('otp'),
        environment: formData.get('environment'),
        isProduction: formData.get('environment') === 'production'
      };

      const alertBox = document.getElementById('activation-alert');
      alertBox.style.display = 'block';
      alertBox.className = 'alert-box alert-success';
      alertBox.textContent = 'جارٍ التحقق وتوليد الشهادة والاعتماد مع هيئة الزكاة...';

      try {
        const res = await fetch('/api/egs/onboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          alertBox.className = 'alert-box alert-success';
          alertBox.textContent = 'تم الربط بنجاح مع ZATCA! رقم الوحدة: ' + data.egs_unit_id;
          setTimeout(() => location.reload(), 1500);
        } else {
          alertBox.className = 'alert-box alert-danger';
          alertBox.textContent = 'خطأ في الاعتماد: ' + (data.message || data.error);
        }
      } catch (err) {
        alertBox.className = 'alert-box alert-danger';
        alertBox.textContent = 'تعذر الاتصال بالخادم: ' + err.message;
      }
    }

    async function handleRenew(e, unitId) {
      e.preventDefault();
      const otp = document.getElementById('renew-otp').value;
      if (!confirm('هل تريد بالتأكيد تجديد الختم الرقمي لهذه الوحدة؟')) return;

      try {
        const res = await fetch('/api/egs/' + unitId + '/renew', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ otp })
        });
        const data = await res.json();
        if (res.ok) {
          alert('تم تجديد الختم الرقمي بنجاح! تاريخ الصلاحية الجديد: ' + data.expires_at);
          location.reload();
        } else {
          alert('فشل التجديد: ' + (data.message || data.error));
        }
      } catch (err) {
        alert('حدث خطأ في الشبكة: ' + err.message);
      }
    }

    async function openEnrichModal(orderId) {
      const bld = prompt('أدخل رقم المبنى للمشتري (4 أرقام):', '1234');
      if (!bld) return;
      const postal = prompt('أدخل الرمز البريدي للمشتري (5 أرقام):', '12211');
      if (!postal) return;
      const street = prompt('أدخل اسم الشارع:', 'طريق الملك فهد');
      const district = prompt('أدخل اسم الحي:', 'العليا');

      try {
        const res = await fetch('/api/b2b/orders/' + orderId + '/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            building_number: bld,
            postal_code: postal,
            street: street || 'الشارع العام',
            district: district || 'وسط المدينة'
          })
        });
        const data = await res.json();
        if (res.ok) {
          alert('تم استكمال العنوان الوطني وتوقيع الفاتورة الضريبية بنجاح! رقم الفاتورة: ' + data.invoice_uuid);
          location.reload();
        } else {
          alert('فشل استكمال العنوان: ' + (data.error || JSON.stringify(data.missing_fields)));
        }
      } catch (err) {
        alert('خطأ: ' + err.message);
      }
    }

    async function dispatchInvoice(invoiceId) {
      try {
        const res = await fetch('/api/invoices/' + invoiceId + '/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        if (res.ok) {
          alert('حالة إرسال الفاتورة: ' + data.status);
          location.reload();
        } else {
          alert('فشل الإرسال: ' + (data.message || data.error));
        }
      } catch (err) {
        alert('خطأ في الاتصال: ' + err.message);
      }
    }

    async function openPartialCreditModal(invId, invUuid, grandTotal) {
      const amountStr = prompt('أدخل مبلغ الاسترجاع الجزئي بالريال (الحد الأقصى: ' + grandTotal + ' ر.س):', (grandTotal / 2).toFixed(2));
      if (!amountStr) return;
      const refundAmount = parseFloat(amountStr);
      if (isNaN(refundAmount) || refundAmount <= 0 || refundAmount > grandTotal) {
        alert('مبلغ الاسترجاع غير صالح');
        return;
      }
      const reason = prompt('سبب الاسترجاع (إشعار دائن 381):', 'استرجاع صنف معيب أو جزئي') || 'استرجاع جزئي';
      try {
        const res = await fetch('/api/invoices/' + invId + '/partial-credit-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refundAmount, returnReason: reason })
        });
        const data = await res.json();
        if (res.ok) {
          alert('تم إصدار الإشعار الدائن 381 بنجاح! رقم الـ ICV: ' + data.creditNote.icv);
          location.reload();
        } else {
          alert('فشل إصدار الإشعار الدائن: ' + (data.message || data.error));
        }
      } catch (err) {
        alert('خطأ: ' + err.message);
      }
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
