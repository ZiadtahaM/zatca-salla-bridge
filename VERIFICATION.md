# Verification Ladder and Production Readiness Gate

This document records the verification framework for zatca-salla-bridge. Every claim of capability, reliability, or compliance must occupy an explicit tier in the verification hierarchy. Claims must not conflate local test execution with statutory accreditation.

## Four-Tier Verification Hierarchy

### Tier 1: Local Automated Test Suite
This tier exercises pure business logic, data models, schema validation, and unit-level calculations in Node.js.
Execution command: `npm test`
Current coverage: 91 tests passing across 15 test suites.
Properties validated:
- Halala rounding balance satisfying BR-CO-10 and BR-CO-15.
- ECDSA secp256k1 cryptographic signature generation over SHA-256 invoice digests.
- QR code generation adhering to the nine mandatory ZATCA TLV tags within single-byte BER length boundaries.
- Zod schema validation across Salla order webhooks and internal data models.
- XML canonicalization and XPath transformation logic for UBL 2.1 documents.
Boundary limitation: Tier 1 does not prove database transaction isolation, trigger execution, or external network connectivity.

### Tier 2: Real Database Engine and Invariant Verification
This tier executes against a real PostgreSQL 16 engine running in Docker on 127.0.0.1:5432. All migrations (001 through 004) are applied directly.
Execution commands:
- Database migrations: applied via Docker psql scripts.
- Schema verification: `npm run verify`
- Live PostgreSQL lifecycle and concurrency suite: `npx tsx --test tests/real-postgres-lifecycle-and-concurrency.test.ts`
- Concurrency benchmark: `npm run benchmark`
Properties validated:
- Monotonic sequential invoice counter incrementation per EGS unit under advisory transaction locks.
- Unbroken Previous Invoice Hash chaining across sequential records.
- Partial unique index enforcement on `uq_invoices_order_original`, blocking duplicate original invoices with error code 23505.
- Scoped replacement insertion on `(egs_unit_id, order_id)` when `replaces_invoice_id` is set.
- Remediation retry idempotency returning identical records without duplicate credit notes or replacement invoices.
- Immutability trigger protection on audit_logs (`trg_audit_logs_immutable`), raising TAMPER_EVIDENT_PROTECTION on update or delete attempts.
- Strict state machine transitions on order synchronization records, enforcing thirteen canonical states and rejecting invalid jumps.
Boundary limitation: Tier 2 does not prove network protocol compatibility with ZATCA Fatoora servers or external Salla webhook delivery.

### Tier 3: External Sandbox and Developer Portal Verification
This tier verifies network payloads, authentication sequences, and HTTP payload formats against external API contracts.
Execution commands:
- Developer Portal live check: `npx ts-node tools/cli/zatca-developer-portal-live-check.ts`
- Salla webhook verification tests: `tests/salla-webhook.test.ts`
Properties validated:
- Six-digit OTP onboarding sequence exchanging compliance CSID for production credentials.
- Compliance checks across the required six document types (Standard and Simplified invoices, credit notes, debit notes).
- Clearance endpoint submission (`/invoices/clearance`) for Standard B2B invoices.
- Reporting endpoint submission (`/invoices/reporting`) for Simplified B2C invoices within twenty-four hours.
- Webhook signature authentication using timing-safe HMAC-SHA256 comparison.
Boundary limitation: ZATCA Sandbox accepts structurally valid test certificates without legal enforcement. Sandbox clearance does not equal formal production onboarding.

### Tier 4: Legal and Operational Production Approval
This tier requires organizational, statutory, and production onboarding sign-offs before live commerce traffic cutover.
Requirements for completion:
- Merchant production CSID issued through the official ZATCA Fatoora portal using live commercial registration.
- Active Salla OAuth credentials bound to the production merchant store.
- Independent legal and tax advisor review confirming VAT returns match statutory requirements under Article 52 and Article 66.
- Physical audit log retention procedure documented for six years standard, eleven years for movable capital assets, and fifteen years for immovable capital assets.
- Production secret management configured without fallback defaults.

## Master Verification Gates

The repository enforces sixteen automated verification gates through `npm run verify`. All gates must exit with status zero before release:

| Gate Identifier | Target Component | Verification Objective |
| :--- | :--- | :--- |
| GATE-01 | Cryptographic Signature Engine | Verifies ECDSA signature validity against public key |
| GATE-02 | TLV QR Code Generator | Confirms tag length limits under 700 characters |
| GATE-03 | XML Builder and Canonicalizer | Checks UBL 2.1 compliance with ZATCA naming conventions |
| GATE-04 | Previous Invoice Hash Chain | Asserts cryptographic continuity across invoice sequences |
| GATE-05 | Monotonic ICV Sequencer | Prevents counter gaps, reuse, and duplicate numbering |
| GATE-06 | Halala Rounding Balance | Confirms exact tax exclusive plus tax amount parity |
| GATE-07 | Salla Webhook Signature | Validates HMAC-SHA256 authentication and replay guards |
| GATE-08 | Credit Note Reason Code | Enforces mandatory debit and credit note amendment codes |
| GATE-09 | National Address Validation | Rejects B2B invoices missing required Saudi address parts |
| GATE-10 | CSID Non-Destructive Renewal | Verifies certificate renewal preserves ICV and PIH state |
| GATE-11 | Fastify Health Probes | Confirms `/health` shallow and `/ready` deep probe responses |
| GATE-12 | Database Invariant Trigger | Validates tamper prevention on audit_logs in PostgreSQL |
| GATE-13 | Sensitive Field Redaction | Checks diagnostic logs for zero credential leakage |
| GATE-14 | VAT Return Export Accuracy | Confirms XML DOM parsing matches Box 1 through Box 5 rules |
| GATE-15 | Replacement Document Constraint | Proves rejected invoice replacement inserts cleanly |
| GATE-16 | Production Secret Guard | Asserts fatal exit when production secrets are omitted |

## Reproducibility Protocol

To reproduce the verification suite on a fresh clone:
1. Ensure Docker Desktop is active.
2. Start the database container: `docker compose up -d zatca-postgres`
3. Wait for PostgreSQL readiness on 127.0.0.1:5432.
4. Execute test suite: `npm test`
5. Execute verification runner: `npm run verify`
6. Execute TypeScript typecheck: `npx tsc --noEmit`
7. Execute benchmark suite: `npm run benchmark`
