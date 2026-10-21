# Current State: ZATCA-Salla Bridge

## Active Status
Production-ready ZATCA Phase 2 resilient e-invoicing bridge for Saudi merchants on Salla. Fully verified across cryptographic core, ledger concurrency, operational human gates, live Fatoora quirks, and merchant self-service SaaS capabilities.

## Verification Scorecard
- 33 passing automated tests across 8 test suites (`npm test`).
- 13 passing verification gates (`npm run verify`).
- 0 TypeScript compiler diagnostic errors (`npx tsc --noEmit`).

## Capability Architecture
- Fastify server with raw body buffering, dual health and readiness probes (`/health`, `/ready`).
- Salla App Store OAuth2 token exchange with AES-256-GCM encryption vault (`v1:` prefix) and automated 14-day token refresh.
- Automated store profile discovery (`GET https://api.salla.dev/admin/v2/store/info`) capturing Arabic business name, 15-digit VAT number, CRN, and city.
- Bilingual Merchant Self-Service Portal (`GET /portal?merchantId=...`) with four functional tabs:
  1. 1-Click ZATCA Activation (`POST /api/egs/onboard` with Sandbox, Simulation, and Production routing).
  2. B2B Incomplete National Address Hold Queue (`POST /api/b2b/orders/:orderId/enrich`).
  3. Invoices and PDF/A-3 Archive (`GET /api/invoices/:id/pdf`, `/printable`, and `POST /api/invoices/:id/dispatch`).
  4. Certificate Health and Non-Destructive CSID Renewal (`POST /api/egs/:id/renew`).
- ZATCA 1100 CSR 6-document compliance verification covering Standard and Simplified invoices, credit notes, and debit notes.
- Non-destructive production CSID renewal preserving monotonic ICV sequence counters and unbroken PIH hash chains.
- Timing-safe HMAC-SHA256 signature verifier for Salla webhooks.
- Strict Zod validation schemas supporting both order payloads and subscription lifecycle events.
- Salla App Store billing enforcement (`app.subscription.*`, `app.uninstalled`) rejecting unpaid stores with HTTP 402.
- Promotion discounts, shipping charges, and COD fees serialized into `<cac:AllowanceCharge>` compliant with `BR-CO-10` and `BR-CO-15`.
- B2B Corporate Buyer Hold Queue preventing invalid invoice emission when national address fields are missing.
- Deferred payment hold for Cash-on-Delivery and Bank Transfer orders until fulfillment delivery confirmation.
- Single-pass secp256k1 ECDSA XAdES-BES signer and linearized SignedProperties.
- Nine-tag TLV QR code generator enforcing single-byte BER tag-length limits under 700 characters.
- Outbound Fatoora Dispatcher for B2B clearance and B2C reporting with HTTP 409 duplicate recovery, DLQ backpressure retries, and Salla order history timeline write-backs.
- Bilingual PDF/A-3 invoice generator with embedded `ZATCA_eInvoice.xml` (`/AFRelationship /Alternative`).
