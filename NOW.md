# Current State: ZATCA-Salla Bridge

## Active Focus
Production-grade ZATCA Phase 2 resilient e-invoicing bridge for Saudi merchants on Salla and Zid (Waves 24 & 25).

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
- [x] 13/13 unit and integration tests passing across all suites.
- [x] Full TypeScript compilation (tsc) with zero errors.
