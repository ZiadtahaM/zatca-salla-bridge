# Go-To-Market Outreach Playbook & Demo Script (`zatca-salla-bridge`)

## 1. GitHub Issue Replies (`github.com/SallaApp/ZATCA/issues`)

### Target A: Issue #54 (`need charged support` / Shipping, COD, and Promo Coupon `<cac:AllowanceCharge>` Math)
```markdown
If you are hitting `BR-CO-10` or `BR-CO-15` rejections when a Salla order contains shipping fees, COD fees, or promo discounts, the root cause is that document-level `<cac:AllowanceCharge>` blocks must be emitted between `<cac:PaymentMeans>` and `<cac:TaxTotal>`, and `<cbc:TaxExclusiveAmount>` must equal `LineExtensionAmount - AllowanceTotalAmount + ChargeTotalAmount` before computing 15% VAT.

We built a free pre-flight validator and an open drop-in bridge that handles Salla `discounts` (`ChargeIndicator: false`) and `shipping_cost` + `cash_on_delivery` (`ChargeIndicator: true`) with exact `BR-CO-10` / `BR-CO-15` reconciliation.

You can paste your raw Salla webhook JSON or UBL 2.1 XML into the bilingual pre-flight debugger here to see the exact line-level math check before submitting to Fatoora:
https://<YOUR_DOMAIN>/debugger
```

### Target B: Issues #49, #52, #57, #59 (`invalid-invoice-hash` / `Invalid signed properties hashing`)
```markdown
`invalid-invoice-hash` and `Invalid signed properties hashing` happen when:
1. `xades:SignedProperties` is formatted with indentation/newlines that drift after DOM injection, or the digest is computed on raw bytes instead of the ASCII hex string of the SHA-256 digest before Base64 encoding.
2. `ext:UBLExtensions`, `cac:Signature`, and the `QR` `AdditionalDocumentReference` leave trailing whitespace nodes when ZATCA runs its XPath strip prior to hashing.
3. Node/OpenSSL double-hashes the 32-byte digest during `secp256k1` ECDSA signing.

You can test your signed XML against our pre-flight debugger (checks C14N 1.1 post-XPath hash parity, NFC Arabic normalization, and TLV QR bounds in real time):
https://<YOUR_DOMAIN>/debugger
```

### Target C: Issue #74 (`QRCODE_INVALID` on Long Arabic Seller Names > 64 Chars)
```markdown
When an Arabic seller name exceeds 63 UTF-8 characters (126+ bytes), `String.length` vs `Buffer.byteLength(val, 'utf8')` corrupts the TLV offset, and exceeding 127 bytes crosses the single-byte BER length boundary (`0x80`), which ZATCA's QR parser rejects.

Our pre-flight debugger inspects Tags 1 to 9 at the raw byte level, verifies the 88-byte SPKI DER public key in Tag 8, and checks the 127-byte single-byte BER limit:
https://<YOUR_DOMAIN>/debugger
```

---

## 2. ZATCA Fatoora Community Replies (`zatca1.discourse.group`)

### English / Arabic Reply for `503 Service Unavailable`, `409 Conflict`, and `PIH` Chain Breaks
```markdown
**English:**
When Fatoora returns `502`/`503`/`504` or Cloudflare `403` HTML block pages during peak hours, rolling back your database transaction creates an `ICV` gap, while retrying without row-level locking corrupts the `PIH` hash chain. Also, if Fatoora ingested the invoice right before a `504` timeout, the retry returns `HTTP 409` (`Duplicate-Invoice`).

We built a Salla/Zid ZATCA Phase 2 bridge that:
1. Locks the EGS unit row (`SELECT ... FOR UPDATE`) per branch/POS terminal so `ICV` and `PIH` chains never collide or gap.
2. Holds incomplete B2B orders in a pre-signing enrichment queue so missing 6-part National Addresses never burn an `ICV`.
3. Defers COD and Bank Transfer orders until `completed`/`delivered` status.
4. Treats post-timeout `HTTP 409` duplicate UUID responses as idempotent recovery.

Test your XML or Salla order JSON on our free pre-flight debugger:
https://<YOUR_DOMAIN>/debugger

---

**العربية:**
عند حدوث انقطاع مؤقت في بوابة فاتورة (`502` / `503` / `504`) أو ظهور أخطاء `invalid-invoice-hash` و `BR-CO-10` في متاجر سلة وزد (الربط والتكامل - المرحلة الثانية)، فإن التراجع عن المعاملة يسبب فجوة في الرقم التسلسلي (`ICV`) أو كسر في سلسلة التشفير (`PIH`).

قمنا بتطوير جسر ربط جاهز لمتاجر سلة وزد مع فاحص استباقي مجاني (Pre-Flight Debugger) يقوم بـ:
1. فحص ملفات الـ XML وبيانات طلبات سلة قبل إرسالها للهيئة واكتشاف أخطاء الضريبة والخصومات والشحن (`AllowanceCharge`) والعنوان الوطني لعملاء الشركات (`B2B`).
2. تعليق فواتير الدفع عند الاستلام (`COD`) والتحويل البنكي تلقائياً حتى اكتمال التسليم لمنع التزامات ضريبية على الطلبات الملغاة.
3. إصدار فواتير `PDF/A-3` ثنائية اللغة مدمج بها ملف الـ XML المعتمد ورمز الـ QR.

يمكنك تجربة الفاحص المجاني مباشرة من هنا:
https://<YOUR_DOMAIN>/debugger
```

---

## 3. Direct Outreach to Saudi Salla Merchants & ERP Agencies (WhatsApp / LinkedIn / Telegram)

### Message to Salla Store Owners (Wave 24 & Wave 25 Compliance)
```text
السلام عليكم،
لاحظت أن متجركم على منصة سلة مشمول في موجات الربط والتكامل للمرحلة الثانية مع هيئة الزكاة والضريبة والجمارك (فوترة).

أغلب المتاجر تواجه 3 مشاكل تسبب غرامات أو رفض للفواتير:
1. اختلاف حساب الضريبة (BR-CO-10) عند وجود كود خصم أو رسوم شحن أو دفع عند الاستلام.
2. إصدار فواتير ضريبية لطلبات الدفع عند الاستلام قبل استلام العميل للطلب، مما يلزم المتجر بضريبة القيمة المضافة حتى لو رفض العميل الاستلام.
3. رفض فواتير الشركات (B2B) لعدم وجود العنوان الوطني المكون من 6 أجزاء في صفحة الدفع بسلة.

جهزنا لكم نظام ربط مباشر مع سلة يحل هذه المشاكل بالكامل ويصدر فواتير PDF/A-3 معتمدة مع إشعارات الدائن (Credit Notes) للمرتجعات تلقائياً.

يمكنكم فحص أي فاتورة لديكم مجاناً عبر الفاحص الاستباقي الخاص بنا:
https://<YOUR_DOMAIN>/debugger

هل يناسبكم اتصال سريع لمدة 10 دقائق لعرض النظام على متجركم؟
```

---

## 4. Live 2-Minute Terminal Demo Script (For Video Recording or Screen-Share)

Run these commands during a live call or Loom recording to prove end-to-end execution:

```powershell
# 1. Start the server
npm start

# 2. Open the bilingual RTL/LTR Pre-Flight Debugger in the browser
Start-Process "http://localhost:3000/debugger"

# 3. Onboard a Merchant EGS Unit with a 6-digit Fatoora OTP
curl.exe -X POST http://localhost:3000/api/egs/onboard `
  -H "Content-Type: application/json" `
  -d "{\"merchantId\":\"salla_demo_01\",\"branchId\":\"riyadh_main\",\"storeName\":\"شركة رواء للملابس الفاخرة\",\"vatNumber\":\"300075588700003\",\"otp\":\"123456\",\"isProduction\":false}"

# 4. Run the full 28-test verification harness (Crypto, OAuth, AllowanceCharge, B2B Hold, COD Gate, PDF/A-3)
npm test
```
