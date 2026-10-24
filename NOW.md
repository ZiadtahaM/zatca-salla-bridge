# Current State: ZATCA-Salla Bridge

## Active Status
Production-ready ZATCA Phase 2 resilient e-invoicing bridge for Saudi merchants on Salla. Fully verified across cryptographic core, ledger concurrency, operational human gates, live Fatoora quirks, merchant self-service SaaS capabilities, and a human-grade bilingual interactive demo portal.

## Verification Scorecard
- 49 passing automated tests across 10 test suites (`npm test`).
- 16 passing master verification gates (`npm run verify`).
- 0 TypeScript compiler diagnostic errors (`npx tsc --noEmit`).
- Track 1 1,000-run concurrency benchmark passing with 0 duplicate ICVs and unbroken PIH chains (`npm run benchmark`).

## Capability Architecture
- Fastify server with raw body buffering, dual health and readiness probes (`/health`, `/ready`), and root redirect (`/` to `/portal`).
- Salla App Store OAuth2 token exchange with AES-256-GCM encryption vault (`v1:` prefix), zero-fill memory wiping of decrypted buffers, and automated 14-day token refresh.
- Automated store profile discovery capturing Arabic business name, 15-digit VAT number, CRN, and city.
- Human-Grade Bilingual Merchant Self-Service Portal (`GET /portal` and `GET /`) featuring Salla enterprise typography (Cairo and IBM Plex Sans Arabic) and palette (`#004d40`, `#00b16a`, `#f8fafc`):
  1. Auto-seeding interactive demo store (`salla_demo_store`, متجر لمسات نجد للعود والعطور الفاخرة) for first-time visitors with zero empty-state friction and clear demo watermarking (`تجريبي - فواتير غير ضريبية`).
  2. Live 1-Click Test Invoice Generator (`POST /api/demo/generate-test-invoice`) signing real secp256k1 invoices in 60 milliseconds.
  3. Scannable visual QR Code endpoint (`GET /api/invoices/:id/qr`) generating PNG images verifiable by phone camera or the official ZATCA app, with watermarking for uncleared standard B2B drafts.
  4. Bilingual printable tax invoice (`GET /api/invoices/:id/printable`) with embedded visual QR code and red warning banners for uncleared B2B invoices.
  5. Four operational tabs:
     - 1. التفعيل الفوري (1-Click ZATCA) with Sandbox, Simulation, and Production routing.
     - 2. طابور فواتير الشركات B2B with enrichment modal supporting 6-component National Address validation (Street, Building Number, District, City, Postal Code, Country) plus Buyer VAT or CRN (`BR-KSA-09`, `BR-KSA-63`).
     - 3. سجل الفواتير with live inspection modal, granular status badges, and 381 Partial Credit Note modal with real-time 15% VAT calculation.
     - 4. صحة الختم والـ DLQ with non-destructive CSID renewal.
  6. Strategic Trust and Compliance Guarantees section addressing merchant doubts regarding 2026 ZATCA rules, 80ms background execution, AES-256 vault encryption, and 6+ year retention under Article 66 of KSA VAT Regulations.
- Halala-level VAT-inclusive rounding reconciler (`reconcileHalalaRounding`) ensuring `TaxExclusiveAmount + TaxAmount === amounts.total.amount` with zero halala drift while strictly satisfying `BR-CO-10` and `BR-CO-15`.
- Partial Credit Note (381) generator and standalone developer REST APIs (`POST /api/v1/sign` and `POST /api/v1/sign-and-submit`) for custom PHP, Laravel, and Odoo integrations.
- Automated AES-256-GCM encrypted snapshot exporter (`GET /api/ops/backup`) and integrity validator (`POST /api/ops/backup/verify`) guaranteeing statutory audit compliance under Article 66 and disaster recovery.
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
- Outbound Fatoora Dispatcher for B2B clearance and B2C reporting with HTTP 409 duplicate recovery, DLQ backpressure retries, and Salla order history timeline write-backs.
- Bilingual printable tax invoice generator with embedded `ZATCA_eInvoice.xml` (`/AFRelationship /Alternative`).
- Concurrency benchmark tool (`npm run benchmark`) testing stepping levels (1, 5, 10, 20) with 1,000 synthetic invoices, asserting zero duplicate ICVs and unbroken PIH hash chains.
