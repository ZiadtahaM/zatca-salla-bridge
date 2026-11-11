# Product Execution and Implementation Plan

## 1. Roadmap Milestones

The product execution roadmap spans eight disciplined stages designed to establish reliable tax operations.

| Milestone | Target Domain | Execution State | Core Deliverables |
| --- | --- | --- | --- |
| Stage A | Market, Competitor, and Regulatory Analysis | Complete | Problem statement definition, statutory grounding, and competitive matrix |
| Stage B | Domain Model and Invariant Formalization | Complete | Ubiquitous vocabulary, state transition rules, and architecture blueprints |
| Stage C | Architectural Foundation and Constraint Repairs | Complete | Partial unique index migration, authentic data persistence, and database advisory locks |
| Stage D | Vertical Slice Integration | Complete | Webhook ingestion, canonical event normalization, and ledger persistence |
| Stage E | Fault Injection and Failure Recovery Testing | In Progress | Advisory lock contention tests, network timeout retries, and rejection self-healing |
| Stage F | Merchant Operations Experience | Planned | Arabic and English merchant dashboard, status visibility, and manual data enrichment |
| Stage G | Controlled Pilot Preparation | Planned | Eligibility screening criteria, onboarding runbooks, and emergency rollback procedures |
| Stage H | Release Readiness and Evidence Auditing | Planned | Verification matrix sign-off, sandbox simulation artifacts, and legal compliance checks |

## 2. Foundation and Constraint Repairs Execution Record

Stage C resolved core architectural defects identified during platform audits.

| Work Item | Targeted Problem | Technical Solution | Verification Evidence |
| --- | --- | --- | --- |
| Partial Unique Index Scope (Migration 004) | Replacing rejected invoices triggered database unique constraint collisions on order identifiers. | Rescoped `uq_invoices_order_original` to apply only to non-replaced, non-rejected records. Added `rejected_reporting` to status enumeration. | Applied migration cleanly in PostgreSQL 16. Verified duplicate rejection and replacement flow in test suite. |
| Authentic Order Persistence | Retry routines fell back to synthetic customer names, dummy emails, and fake item lists. | Added `raw_order_payload` JSONB columns to preserve authentic merchant payloads. Resubmission routines fail closed when payloads are missing. | Replaced synthetic fallbacks in invoice generator. Verified rejection of missing source data in edge case tests. |
| Remediation Idempotency | Retrying rejection remedies generated duplicate credit notes and incremented counter values erroneously. | Assigned deterministic idempotency keys based on rejected invoice identifiers to prevent duplicate creations. | Validated idempotency key construction and duplicate suppression in test harness. |
| Cluster Advisory Locks | Concurrency across multiple application pods created race conditions during counter increments. | Replaced process-local memory locks with PostgreSQL transaction advisory locks keyed by device identifiers. | Implemented `pg_advisory_xact_lock` across all invoice and credit note issuance routines. |
| XML DOM Parsing for Tax Allocations | String matching misclassified mixed-basket orders across quarterly tax return buckets. | Integrated DOM parsing to inspect individual tax subtotal elements and categorize amounts by exemption code. | Verified halala-accurate allocation across Box 1, Box 3, Box 4, and Box 5. |
| Production Environment Guardrails | Default encryption keys and test credentials posed operational security hazards in live deployments. | Added startup validation that throws fatal exceptions when production secrets are missing or unconfigured. | Verified startup guards in authentication session and encryption vault modules. |

## 3. Next Milestone Priorities

Immediate engineering focus centers on completing Stage E fault injection and preparing Stage F merchant dashboard interfaces:

Concurrency stress testing will evaluate PostgreSQL advisory locks under simulated multi-worker loads.

Rejection handling workflows will verify automated credit note issuance and replacement reporting under simulated ZATCA downtime.

Pilot onboarding materials will document store installation prerequisites and step-by-step credentials configuration.
