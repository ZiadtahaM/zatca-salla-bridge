# Risk Register and Operational Safeguards

This register tracks operational, architectural, statutory, and commercial failure modes for zatca-salla-bridge. Risk prevention is automated. The platform enforces strict controls to prevent non-compliance, data loss, and cryptographic corruption across all transaction lifecycles.

## Statutory and Tax Compliance Risk Matrix

| Risk Domain | Regulatory Basis and Hazard | Potential Impact | Automated Technical Safeguard |
| :--- | :--- | :--- | :--- |
| Simplified Reporting Delay | Article 53 of VAT Regulations requires reporting within 24 hours of invoice generation. Stalled network queues risk exceeding this window. | Statutory fines and tax audit flags | Asynchronous retry queue with randomized exponential backoff. Visual dashboard alerts at 18 hours. State transition to expired at 24 hours for manual filing. |
| Cryptographic Sequence Fork | Competing worker instances process concurrent transactions and generate identical ICVs or branching PIH chains. | Rejection by ZATCA and complete sequence corruption | Monotonic counter and PIH generation locked inside PostgreSQL transactions via `pg_advisory_xact_lock(hashtext('egs_unit:' \|\| egs_unit_id))`. Scoped unique indexes on database. |
| Capital Asset Retention Error | Article 66(1) and Article 52 require varying retention durations (6 years standard, 11 years movable capital assets, 15 years immovable assets). | Penalties for premature document destruction | Transaction metadata tracks asset category. Dynamic retention horizon calculation prevents storage deletion prior to full statutory maturation. |
| Advance Payment Invoicing | Advance receipts for delayed deliveries issued without code 386 or subsequent deliveries issued without code 388 deduction. | Distorted tax timing and double tax assessment | State machine tracks milestone payments. Prepayments issue code 386 documents, while delivery completions issue code 388 records referencing the original UUID. |

## Security and Privacy Risk Matrix

| Risk Domain | Threat Vector and Vulnerability | Potential Impact | Automated Technical Safeguard |
| :--- | :--- | :--- | :--- |
| Personal Data Exposure | Logging unencrypted Saudi consumer identities, phone numbers, and addresses in violation of PDPL Royal Decrees M/19 and M/148. | Regulatory sanctions and merchant liability | Application logging filters redact phone numbers, national IDs, and delivery addresses. AES-256-GCM encryption at rest for credentials and OAuth secrets. |
| Development Secret Fallback | Application booting in production using hardcoded development encryption keys or placeholder webhook secrets. | Total compromise of merchant sessions and cryptographic vaults | Boot sequence checks `NODE_ENV === 'production'`. Throws fatal error and terminates process if `ENCRYPTION_MASTER_KEY` or `SALLA_WEBHOOK_SECRET` are missing or default. |

## Integration and Infrastructure Risk Matrix

| Risk Domain | Threat Vector and Vulnerability | Potential Impact | Automated Technical Safeguard |
| :--- | :--- | :--- | :--- |
| Salla Webhook Dropping | Transient gateway drops or maintenance restarts losing webhook events. | Unreported taxable transactions and ledger divergence | Inbound webhooks persist to durable transactional inbox table before HTTP 200 response. Keyset-paginated background reconciliation reconciles missed orders. |
| Synthetic Recovery Data | Recovery routines constructing artificial order payloads with placeholder names and fabricated tax calculations. | Submission of fraudulent records to tax authorities | Mandatory raw order persistence in PostgreSQL (`raw_order_payload`). Recovery functions fail closed with `CANNOT_RETRY_WITHOUT_SOURCE_DATA` if missing. |
| Credit Note Duplication | Automated cancellation credit notes retrying after network timeouts without idempotency keys. | Corrupted merchant revenue balances and duplicate credits | Deterministic idempotency keys formatted as `${rejected_invoice_id}:cancel_remedy`. Database unique constraints return existing credit note record on retry. |

## Maintenance and Audit Procedures

Every quarterly tax filing requires running the automated integrity verification suite against the live ledger. Integrity checks must pass. Merchants must verify database backup archives using the provided verification tooling before submitting final VAT return forms to ZATCA.
