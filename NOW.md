# Current Project State: ZATCA-Salla Bridge

This document tracks the active operational state, verified capabilities, database migrations, and current execution milestones for the zatca-salla-bridge platform.

## Active Status
The bridge provides a ZATCA Phase 2 e-invoicing service for merchants who operate their retail stores on Salla in Saudi Arabia. All core architectural components cover cryptographic compliance, serialized ledger concurrency, statutory invoice remediation, and bilingual merchant interfaces.

## Nine Master Governance Artifacts
The repository maintains nine primary governance artifacts that define product boundaries and technical proofs:
- PRODUCT_CHARTER.md: Customer profiles, ICP, core problem statements, target outcomes, scope limits, and exclusions.
- CUSTOMER_EVIDENCE.md: Primary ZATCA and Salla sources, competitor comparison matrix, and merchant pain points.
- DOMAIN_MODEL.md: Ubiquitous language, canonical transactions, event taxonomy, tax decision matrix, and immutable invariants.
- ARCHITECTURE.md: Perimeter security, durable event inbox, outbox pattern, dead letter queue, and multi-instance concurrency design.
- DECISIONS.md: Architectural decision records detailing alternatives considered and validation evidence.
- EXECUTION_PLAN.md: Phased execution roadmap across Stages A through H with verifiable acceptance criteria.
- VERIFICATION.md: Four-tier verification ladder, sixteen master verification gates, and reproduction commands.
- RISKS.md: Matrix of statutory, security, data integrity, and integration risks paired with automated safeguards.
- NOW.md: Real-time operational scorecard, applied migrations, and active engineering tasks.

## Verification Scorecard
The following table summarizes the verified technical capabilities and operational metrics recorded in the test environment:

| Area | Verified Metric | Environment |
| :--- | :--- | :--- |
| Automated Test Suites | 91 passing tests across 15 test suites | Node.js test runner |
| Master Verification Gates | 16 passing gates | `npm run verify` |
| Live PostgreSQL Lifecycle Suite | 4 passing invariant gates | Live PostgreSQL 16 on Docker |
| TypeScript Diagnostics | 0 compiler errors | `npx tsc --noEmit` |
| Database Migrations | Migrations 001 through 004 applied | PostgreSQL 16 on Docker |
| Automatic ZATCA Dispatch | Real sandbox submission connected in webhook path | Salla webhook route |
| DLQ Retry Scheduler | Active retry loop registered on startup and intervals | Background service loop |
| Tax Category Allocation | Explicit S, Z, E, O tax categories without synthetic defaults | VAT export and generator |
| Replacement Constraints | Scoped partial uniqueness on `(egs_unit_id, order_id)` | PostgreSQL 16 index |
| Source Order Storage | Raw JSONB persistence on invoices and sync records | PostgreSQL 16 tables |
| Concurrency Protection | Session advisory lock `pg_advisory_xact_lock` | PostgreSQL 16 engine |
| Audit Immutability | Trigger `trg_audit_logs_immutable` raises on updates/deletions | PostgreSQL 16 trigger |
| Concurrency Benchmark | 1,000 invoices with 0 duplicate ICVs and intact PIH chains | Concurrency runner |
| GitHub Actions CI | Commit 11c8485 (run 43276280316) passed all gates and suites | Remote Ubuntu runner |
| Webhook Authorization Security | Mandatory HMAC-SHA256 signature verification on authorization | Fastify route guard |
| Electronic Payment Safety Gate | Unconfirmed card payments hold without ICV consumption | Salla webhook engine |
| Network Isolation | Port 5432 bound to loopback `127.0.0.1` | Docker compose config |
| Memory Sanitization | Zero-fill buffer wiping for decrypted secrets | Node.js crypto vault |

## Database Migrations Applied
All schema updates execute through versioned migration scripts applied in sequential order to the database:

| Version | Migration Script | Description |
| :--- | :--- | :--- |
| 001 | 001_initial_schema.sql | Core schema for EGS units, invoices, lines, cryptographic secrets, and immutable audit logs |
| 002 | 002_csid_onboarding.sql | Certificate signing requests, compliance CSIDs, and production CSID credentials |
| 003 | 003_salla_sync_control.sql | Order sync state machine, reconciliation jobs, and discrepancy logs |
| 004 | 004_fix_invoice_replacement_constraints.sql | Replacement index scoping, `rejected_reporting` enum, and raw order payload persistence |

## Active Engineering Priorities
The development team focuses on three ordered priorities to complete the current milestone:

| Sequence | Milestone Phase | Objectives and Deliverables | Current Status |
| --- | --- | --- | --- |
| Priority 1 | Webhook-to-ZATCA Pipeline | Direct sandbox submission in webhook, active DLQ scheduling, and correct tax-event gates | Complete |
| Priority 2 | PostgreSQL Invariant Testing | Live PostgreSQL 16 tests for partial index rejection, scoped replacements, remedy idempotency, and concurrent advisory locks | Complete |
| Priority 3 | Release Pipeline | Execute full build, test suite, and verification gates, followed by Git commit and push to remote origin | Complete |
