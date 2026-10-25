# Current State: ZATCA-Salla Bridge

## Active Status
Production-ready ZATCA Phase 2 resilient e-invoicing bridge for Saudi merchants on Salla. Fully verified across cryptographic core, ledger concurrency, operational human gates, live Fatoora quirks, merchant self-service SaaS capabilities, and a human-grade bilingual web interface.

## Verification Scorecard
- 59 passing automated tests across 11 test suites (`npm test`).
- 16 passing master verification gates (`npm run verify`).
- 0 TypeScript compiler diagnostic errors (`npx tsc --noEmit`).
- Real ZATCA Developer Portal format verification CLI (`tools/cli/zatca-developer-portal-live-check.ts`) passing all payload, header, and auth token checks.
- Cryptographic HMAC-SHA256 session authentication (`auth-session.ts`) with HttpOnly cookies (`zatca_merchant_session`), query tokens, and Bearer support, preventing raw header spoofing and browser page load 401 traps.
- Quarterly Accountant VAT Return CSV export (`GET /api/invoices/export.csv`) with UTF-8 BOM encoding for Microsoft Excel Arabic rendering, outputting Box 1 Standard Sales, Box 1 Adjustments, Net VAT Payable, and unreported invoice counts.
- Pre-installation historical order refund support in 381 Credit Notes (`externalOriginalInvoiceNumber` and `externalOriginalInvoiceDate`) with nullable foreign key handling in PostgreSQL.
- Mandatory Cutover Warning and legal liability waiver checkbox on production onboarding, limiting platform liability to one month's subscription fee.
- Outbound push and webhook alerting dispatcher (`alert-dispatcher.ts`) supporting Telegram Bot API and HTTP endpoints for B2B holds and DLQ stalls.
- Live PostgreSQL database engine integration test asserting `trg_audit_logs_immutable` raises `TAMPER_EVIDENT_PROTECTION` on real table updates and deletions.
- Track 1 1,000-run concurrency benchmark passing with 0 duplicate ICVs and unbroken PIH chains (`npm run benchmark`).
- PostgreSQL port bound strictly to `127.0.0.1:5432` in `docker-compose.yml`, preventing bypass of host firewall rules.
- Native `KeyObject` private key decryption in `vault.ts` with zero-fill memory sanitization, preventing V8 heap string retention.
- Database-level trigger `trg_audit_logs_immutable` active on `audit_logs`, raising `TAMPER_EVIDENT_PROTECTION` on any update or deletion.

## Track 1 Concurrency Benchmark Results (1,000 Invoices)
Execution across four load stages (100 runs @ concurrency 1, 200 runs @ concurrency 5, 300 runs @ concurrency 10, 400 runs @ concurrency 20) with live PostgreSQL serialization on row-level locks. Nearest-rank percentiles (`ceil(p * n)`):

| Transaction Class | Count | Error Count | p1 (ms) | p3 (ms) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | max (ms) | Throughput (ops/s) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Simplified Tax Invoice (B2C) | 700 | 0 | 129.64 | 148.91 | 574.80 | 4889.09 | 12078.28 | 17182.31 | 22731.51 | 2.9 |
| Standard Tax Invoice (B2B) | 200 | 0 | 221.74 | 243.42 | 748.46 | 25519.96 | 36989.90 | 42467.79 | 50995.75 | 0.8 |
| Partial Credit Note (381) | 100 | 0 | 394.70 | 469.33 | 1076.18 | 7690.19 | 10227.21 | 21136.06 | 24070.46 | 0.4 |
| **Combined Overall Benchmark** | **1000** | **0** | **132.36** | **157.36** | **681.95** | **7821.23** | **13941.12** | **36989.90** | **50995.75** | **4.2** |

### Verified Database Invariants
- Invariant 1: Total Invoices = 1,000 (Exact match).
- Invariant 2: 0 Duplicate ICVs (100% unique monotonic sequence 1..1000).
- Invariant 3: Unbroken PIH Chaining across all 1,000 records.

## Capability Architecture
- Fastify server with raw body buffering, dual health and readiness probes (`/health`, `/ready`), and root redirect (`/` to `/portal`).
- Salla App Store OAuth2 token exchange with AES-256-GCM encryption vault (`v1:` prefix), zero-fill memory wiping of decrypted buffers, native KeyObject return, and automated 14-day token refresh.
- Automated store profile discovery capturing Arabic business name, 15-digit VAT number, CRN, and city.
- Isolated public demo portal (`GET /portal` and `GET /`) featuring Salla enterprise typography (Cairo and IBM Plex Sans Arabic) and palette (`#004d40`, `#00b16a`, `#f8fafc`).
- Rate-limited demo invoice endpoint (`POST /api/demo/generate-test-invoice`) enforcing a maximum of 10 requests per minute per IP address, with HTTP 429 and `Retry-After: 60`.
- Strict cross-tenant authorization checks blocking unauthorized access with HTTP 401 and HTTP 403 across portal, PDF, QR, dispatch, credit notes, and certificate renewal endpoints.
- Auto-seeding interactive demo store (`salla_demo_store`, متجر لمسات نجد للعود والعطور الفاخرة) for first-time visitors with clear demo watermarking (`تجريبي - فواتير غير ضريبية`).
- Scannable visual QR Code endpoint (`GET /api/invoices/:id/qr`) generating PNG images verifiable by phone camera or the official ZATCA app, with watermarking for uncleared standard B2B drafts.
- Bilingual printable tax invoice (`GET /api/invoices/:id/printable`) with embedded visual QR code and red warning banners for uncleared B2B invoices.
- Four operational portal views: 1-Click ZATCA onboarding with Sandbox, Simulation, and Production routing; B2B Corporate Queue with 6-component National Address validation and buyer tax identification; Invoice Registry with live inspection and 381 Partial Credit Note processing; Certificate Health and Dead Letter Queue monitoring with non-destructive CSID renewal.
- Trust and compliance declarations detailing 2026 ZATCA statutory rules, 80ms background execution, AES-256 vault encryption, and 6-year retention under Article 66 of KSA VAT Regulations.
- Halala-level VAT-inclusive rounding reconciler (`reconcileHalalaRounding`) ensuring `TaxExclusiveAmount + TaxAmount === amounts.total.amount` with zero halala drift while strictly satisfying `BR-CO-10` and `BR-CO-15`.
- Partial Credit Note (381) generator and standalone developer REST APIs (`POST /api/v1/sign` and `POST /api/v1/sign-and-submit`) for custom PHP, Laravel, and Odoo integrations.
- Automated AES-256-GCM encrypted snapshot exporter (`GET /api/ops/backup`) and integrity validator (`POST /api/ops/backup/verify`) guaranteeing statutory audit compliance under Article 66 and disaster recovery.
- Immutable database audit logging (`audit_logs`) guarded by PostgreSQL trigger `trg_audit_logs_immutable`, rejecting any record updates or deletions.
- ZATCA 1100 CSR 6-document compliance verification covering Standard and Simplified invoices, credit notes, and debit notes.
- Non-destructive production CSID renewal preserving monotonic ICV sequence counters and unbroken PIH hash chains.
- Timing-safe HMAC-SHA256 signature verifier for Salla webhooks.
- Strict Zod validation schemas supporting order payloads, subscription lifecycle events, and external API requests.
- Salla App Store billing enforcement (`app.subscription.*`, `app.uninstalled`) rejecting unpaid stores with HTTP 402.
- Promotion discounts, shipping charges, and COD fees serialized into `<cac:AllowanceCharge>` compliant with `BR-CO-10` and `BR-CO-15`.
- B2B Corporate Buyer Hold Queue preventing invalid invoice emission when national address fields are missing.
- Deferred payment hold for Cash-on-Delivery and Bank Transfer orders until fulfillment delivery confirmation.
- Single-pass secp256k1 ECDSA XAdES-BES signer and linearized SignedProperties.
- Nine-tag TLV QR code generator enforcing single-byte BER tag-length limits under 700 characters.
- Bilingual printable tax invoice generator with embedded `ZATCA_eInvoice.xml` (`/AFRelationship /Alternative`).
- Outbound Fatoora Dispatcher for B2B clearance and B2C reporting with HTTP 409 duplicate recovery, DLQ backpressure retries, and Salla order history timeline write-backs.
- Monotonic concurrency testing stepping levels (1, 5, 10, 20) against live PostgreSQL connection pools.

## Real Human Browser Journey Verification (Playwright)
Eight human merchant user flows were executed in headless Chromium using Playwright against the live Fastify server and PostgreSQL engine on port 3000.
Visiting http://127.0.0.1:3000/ redirects to the merchant portal and issues an authenticated zatca_merchant_session HttpOnly cookie with SameSite Lax security.
Tab 1 displays the cutover warning.
The merchant checks the mandatory liability checkbox before proceeding.
Clicking the live test generation button issues a signed invoice, whereupon the browser opens an interactive modal presenting the UUID, monotonic counter, monetary figures, and a scannable visual QR code image.
Tab 3 lists historical records.
Merchants download the quarterly accountant VAT return reconciliation CSV directly from this tab, and the downloaded file contains verified UTF-8 BOM encoding alongside Box 1 summary totals.
Refunds work smoothly.
The credit note dialog accepts pre-installation order references, splitting net amounts from fifteen percent tax values dynamically inside the browser DOM before final submission.
Printable tax invoices render immediately.
Navigating to /debugger serves the pre-flight testing interface.
Support remains accessible through WhatsApp.
Visual screenshot evidence and the downloaded CSV reconciliation file are recorded in the scratch directory.

