# System Architecture and Integration Blueprint

## 1. System Overview and Topology

The platform acts as a resilient e-invoicing middleware between Saudi e-commerce stores (Salla and Zid) and the ZATCA Phase 2 (Fatoora) clearance and reporting APIs.

```
                    ┌────────────────────────────┐
                    │    Salla / Zid Webhooks    │
                    └─────────────┬──────────────┘
                                  │ HTTPS POST
                                  ▼
                    ┌────────────────────────────┐
                    │     Perimeter Ingress      │
                    │  (Rate Limit & Signature)  │
                    └─────────────┬──────────────┘
                                  │
                                  ▼
                    ┌────────────────────────────┐
                    │   PostgreSQL Event Inbox   │
                    │      (webhook_queue)       │
                    └─────────────┬──────────────┘
                                  │
                                  ▼
                    ┌────────────────────────────┐
                    │  Background Queue Worker   │
                    │  (Idempotent Normalizer)   │
                    └─────────────┬──────────────┘
                                  │
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                    ▼
     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
     │ Tax Decision │     │ EGS Router   │     │ Hold Queue   │
     │ Engine       │     │ & Mutex      │     │ (B2B/COD)    │
     └───────┬──────┘     └───────┬──────┘     └──────────────┘
             │                    │
             └───────────┬────────┘
                         ▼
             ┌────────────────────────┐
             │ UBL 2.1 Canonicalizer  │
             │ & XAdES-BES Signer     │
             └───────────┬────────────┘
                         │
                         ▼
             ┌────────────────────────┐
             │ Immutable Ledger &     │
             │ ZATCA Dispatch Outbox  │
             └───────────┬────────────┘
                         │
                         ▼
             ┌────────────────────────┐
             │ ZATCA Fatoora Gateway  │
             │ (Clearance / Reporting)│
             └────────────────────────┘
```

## 2. Ingress and Perimeter Security Layer

1. Webhook Signature Verification:
   All incoming requests to `/webhooks/salla` require an HMAC-SHA256 signature passed in header `X-Salla-Signature`. The signature is verified against the raw request body Buffer before JSON parsing using constant-time comparison (`timingSafeEqual`).

2. Rate Limiting:
   Public ingress endpoints enforce token-bucket rate limiting via Fastify to mitigate denial-of-service attempts.

3. Strict Environment Secret Enforcement:
   In production (`NODE_ENV === 'production'`), startup scripts verify that `ENCRYPTION_MASTER_KEY`, `SALLA_WEBHOOK_SECRET`, `SESSION_SECRET`, and `DATABASE_URL` are explicitly configured. Silent fallbacks to development defaults are forbidden and cause process termination on startup.

## 3. Durable Event Processing Pipeline

1. Webhook Queue (Inbox Pattern):
   Incoming webhook payloads are immediately persisted to table `webhook_queue` with status `pending`. Webhook responses return HTTP 200 within 50 milliseconds to prevent upstream timeouts from Salla.

2. Background Worker:
   A dedicated worker drains pending entries from `webhook_queue`. Each event is processed with transaction isolation, ensuring failure of one event does not block others. Failed events increment an `attempts` counter and transition to `failed` with error details.

3. Outbox and Dead Letter Queue (DLQ):
   Outbound transmissions to ZATCA pass through `zatca_dlq` on connection errors (HTTP 500, 502, 503, 504). Exponential backoff with jitter governs retries, alerting operators if an invoice remains unacknowledged after 30 minutes.

## 4. Multi-Instance Concurrency and Data Ownership

1. Distributed Locking:
   To prevent race conditions across multiple server pods, state transitions for a given EGS unit acquire a PostgreSQL transaction-level advisory lock:
   `SELECT pg_advisory_xact_lock(hashtext('egs_unit:' || $1))`
   This guarantees that only one worker process can increment ICV, sign XML, and chain hashes for a specific merchant branch at any given instant.

2. Atomic Ledger Mutations:
   Document generation, ICV counter increment, and hash updates execute within a single PostgreSQL transaction (`BEGIN ... COMMIT`). If signing fails or preflight validation rejects the XML, the transaction aborts cleanly with zero burned counters.

## 5. Storage Schema and Data Segregation

The database architecture employs PostgreSQL 16 with versioned migrations:
- `egs_units`: Stores branch metadata, encrypted private keys (AES-256-GCM), certificates, current ICV, and last document hash.
- `invoices`: Append-only immutable ledger storing UUID, ICV, PIH, invoice hash, signed XML, status, and raw source order payload.
- `order_sync_records`: Operational status tracking Salla order states against tax document lifecycles.
- `order_sync_transitions`: Audit log of every state change.
- `pending_b2b_orders`: Hold queue for corporate orders awaiting national address enrichment.
- `zatca_submissions`: Audit record of raw HTTP request and response payloads from Fatoora.
- `audit_logs`: Tamper-evident operational log protected by database triggers that reject UPDATE and DELETE commands.
