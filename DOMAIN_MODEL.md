# Domain Model and State Invariants

## 1. Ubiquitous Language Glossary

- Electronic Generating Solution (EGS): An accredited physical or virtual POS terminal, server, or cloud middleware producing UBL 2.1 e-invoices.
- Invoice Counter Value (ICV): A monotonically increasing integer unique to each EGS unit, starting at 1 and never resetting or skipping.
- Previous Invoice Hash (PIH): The SHA-256 Base64 hash of the immediately preceding invoice emitted by the same EGS unit. The initial invoice uses SHA-256 of zero (`NWZlY2ViNjAxOTE1...`).
- Tax Invoice (B2B): An e-invoice issued to another taxable enterprise (0100000 / code 388). Requires pre-clearance by ZATCA before customer delivery.
- Simplified Tax Invoice (B2C): An e-invoice issued to a retail consumer (0200000 / code 388). Emitted at point of sale and reported to ZATCA within 24 hours.
- Credit Note: A downward financial adjustment document (code 381) referencing an original invoice UUID and date.
- Tax Point: The statutory moment when value-added tax becomes due under GCC Unified VAT Agreement Article 23.

## 2. Canonical Transactions and Commerce Events

```
                     ┌─────────────────────────────┐
                     │     Salla Ingress Webhook   │
                     └──────────────┬──────────────┘
                                    │
                                    ▼
                     ┌─────────────────────────────┐
                     │    Durable Webhook Queue    │
                     │  (Idempotent Deduplication) │
                     └──────────────┬──────────────┘
                                    │
                                    ▼
                     ┌─────────────────────────────┐
                     │ Canonical Transaction Event │
                     └──────────────┬──────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
[ Prepaid Order ]            [ COD / Deferred ]            [ Refund Event ]
  Card / ApplePay              Cash on Delivery              Full or Partial
  Immediate Tax Point          Hold for Carrier Handover     Issue 381 Credit Note
```

### Event Taxonomy
1. `order.created`: Captured in durable inbox. Evaluates payment method. If paid, triggers immediate tax point. If deferred (COD, bank transfer), placed on deferred payment hold.
2. `order.updated` and `order.status.updated`: Re-evaluates order state. If COD order moves to completed or delivered, unlocks deferred payment hold.
3. `order.shipping.address.updated`: Purely logistical update. Updates sync record without generating tax documents.
4. `shipment.created`: Logistical preparation. Does not confirm physical carrier handover; COD orders remain on hold.
5. `shipment.updated`: If carrier provenance is present (courier name, tracking number) and status confirms handover (`in_transit`, `actual_picked_up_at`) or `delivered`, triggers statutory tax point.
6. `order.refunded`: Generates proportional Credit Note (381) referencing original invoice UUID, preserving cryptographic chain.
7. `order.cancelled`: If cancelled before supply or payment, marks order cancelled with zero tax document generation. If cancelled after invoice issuance, issues cancellation Credit Note (381).

## 3. Tax Decision Matrix

| Transaction Shape | Customer Type | Payment Status | Handover Status | Tax Treatment | Document Emitted |
| --- | --- | --- | --- | --- | --- |
| Standard Retail Sale | B2C (Consumer) | Paid (Card/ApplePay) | Pending | Tax point triggered upon receipt of payment | Simplified Tax Invoice (0200000) |
| Cash on Delivery (COD) | B2C (Consumer) | Unpaid | Creating label | No tax point; hold in sync ledger | None (State: deferred_payment_hold) |
| Cash on Delivery (COD) | B2C (Consumer) | Paid on delivery | Carrier Handover / Delivered | Tax point triggered upon physical supply | Simplified Tax Invoice (0200000) |
| Corporate Order (B2B) | B2B (Taxable Org) | Any | Any | Complete 6-part address verified | Tax Invoice (0100000) for Clearance |
| Incomplete B2B Order | B2B (Taxable Org) | Any | Any | Missing building number / district | Hold in enrichment queue | None (State: pending_b2b_orders) |
| Multi-Purpose Voucher | Any | Paid | Any | Verified voucher metadata or SKU | Out of scope (Category O / VATEX-SA-OOS) | Simplified/Standard with Category O |
| GCC / Foreign Export | Foreign Buyer | Paid | Dispatched | Non-SA country code | Zero-rated export (Category Z / VATEX-SA-32) | Tax Invoice with OTH Scheme |

## 4. Immutable State Invariants

1. Monotonic ICV Invariant:
For any EGS unit, `ICV(N) = ICV(N-1) + 1`. An ICV value is never reused, decremented, or burned without an accompanying cryptographic invoice record in PostgreSQL.

2. Unbroken Hash Chain Invariant:
`PIH(N) = invoice_hash(N-1)`. The cryptographic hash of every emitted document chains to the immediately preceding document from that unit, regardless of whether the preceding document was an invoice, credit note, or reporting-rejected document.

3. Single Authoritative Document Invariant:
Only one active original tax invoice exists per (egs_unit_id, order_id). Corrected or replacement invoices require explicit `replaces_invoice_id` pointers and audit preservation of the preceding document.

4. Zero Synthetic Data Invariant:
No tax document may ever be generated using synthetic names, fake email addresses, or artificial line items. If genuine transaction data is absent, the workflow fails closed and enters `requires_human_review`.

5. Cluster-Wide Mutual Exclusion Invariant:
EGS unit counters and cryptographic states are gated by PostgreSQL advisory transaction locks (`pg_advisory_xact_lock`) and `SELECT ... FOR UPDATE` rows, preventing race conditions across multi-worker instances.

## 5. Unresolved Tax and Legal Inquiries

1. COD return time boundary: When a COD shipment takes over 30 days in transit across customs or remote regions before customer rejection, whether an interim pro-forma document is advisable under Saudi commercial practice.
2. Mixed-basket voucher treatment: When a single order contains both a taxable physical item and an out-of-scope multi-purpose voucher with a storewide discount coupon, the exact apportionment algorithm between the taxable and non-taxable portions under ZATCA guidelines.
