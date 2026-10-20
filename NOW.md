# Current State: ZATCA-Salla Bridge

## Active Focus
Production-grade ZATCA Phase 2 resilient e-invoicing bridge for Saudi merchants on Salla and Zid (Waves 24 & 25). Hardened for commercial production with automated tester army and multi-agent verification swarm.

## Progress Checklist
- [x] Fastify server with raw body buffering and health/readiness endpoints.
- [x] Timing-safe HMAC-SHA256 signature verifier for Salla webhooks.
- [x] Zod validation schema for Salla order creation, updates, and refunds.
- [x] Single-pass ZATCA Section 5.2 XAdES-BES signer with secp256k1 ECDSA and linearized SignedProperties.
- [x] TLV QR encoder with Tags 1 to 9, 127-byte single-byte BER guard, and 700-character ceiling.
- [x] Defensive gateway classifier for Cloudflare HTML 403, 429 rate limits, 401 revocation, and 303 clearance fallback.
- [x] Monotonic ICV and unbroken PIH chain enforced via PostgreSQL SELECT FOR UPDATE row-locking.
- [x] Milestone 1: Automated CSR generation with secp256k1 keypair, ZATCA OIDs, and CSID onboarding pipeline.
- [x] Milestone 2: Salla refund and cancellation webhook ingestion with UBL 2.1 Credit Note 381 and BillingReference generation.
- [x] Milestone 3: Lead Magnet Pre-Flight Debugger API and self-contained bilingual RTL/LTR diagnostic dashboard.
- [x] Multi-stage production Dockerfile and docker-compose.yml configuration.
- [x] Saudi PDPL Law 151/2020 Compliance: Multi-tenant AES-256-GCM vault for private keys and CSID secrets with database check constraints and zero plaintext fallback.
- [x] Filesystem Key Hygiene: Automated cleanup of temporary directories and PEM files in finally blocks.
- [x] Multi-Branch and Retail POS Isolation: Separate EGS stamp units and isolated monotonic hash chains mapped per terminal and branch location.
- [x] Automated CSID Renewal and Expiry Tracking: 7-day proactive warning worker with bilingual Arabic/English merchant alerts.
- [x] Dead Letter Queue (DLQ) Backpressure Monitor: 30-minute stall detection and 24-hour statutory deadline alert escalation.
- [x] Gate 1: Salla OAuth2 Handshake (`POST /webhooks/salla/authorize`) with AES-256-GCM encrypted `merchant_tokens` vault and store info REST client.
- [x] Gate 2: Salla promo discounts, shipping costs, and COD fees serialized into `<cac:AllowanceCharge>` with `BR-CO-10` and `BR-CO-15` tax reconciliation.
- [x] Gate 3: B2B Corporate Buyer Hold Queue (`pending_b2b_orders` / `pending_b2b_enrichment`) and `POST /api/b2b/orders/:orderId/enrich` preventing premature ICV allocation.
- [x] Gate 4: COD and Bank Transfer payment gate deferring invoice signing until `completed` or `delivered` status.
- [x] Gate 5: Bilingual PDF/A-3 Tax Invoice generator (`GET /api/invoices/:id/pdf` and `/printable`) with embedded `ZATCA_eInvoice.xml` (`AFRelationship /Alternative`) and TLV QR payload.
- [x] Quirk 1 & Quirk 2: Cloudflare-safe outbound Fatoora headers and post-timeout HTTP 409 Conflict (`duplicate_uuid_recovered`) idempotent recovery.
- [x] 28/28 tests passing across 7 test suites with exit code 0.
- [x] Unanimous PASS verdicts from independent zero-context subagents.
- [x] Clean TypeScript build (tsc) with 0 diagnostic errors.
