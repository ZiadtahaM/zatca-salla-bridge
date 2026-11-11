# Customer Evidence and Competitive Analysis Audit

## 1. Primary Sources and Regulatory Baseline

The baseline for tax operations relies on three authoritative sources:

| Source Authority | Reference Specification | Core Requirements and Invariants | Evidence Strength |
| --- | --- | --- | --- |
| ZATCA Official Portal | Electronic Invoicing Detailed Technical Guideline (September 2023, Version 2.4) | Enforces monotonic invoice counter values per device, cryptographic chaining through Base64 SHA-256 hashes, twenty-four hour reporting deadlines for simplified invoices, and digital signatures for standard tax invoices. | Authoritative statutory requirement |
| Kingdom of Saudi Arabia Tax Authority | VAT Implementing Regulations (Royal Decree M/113, amended by Ministerial Decisions) | Articles 23 and 27 establish that the date of supply occurs upon dispatch or carrier handover. Article 53 governs advance payments. Articles 40 and 54 define credit note references. Article 66 defines record retention windows ranging from six to fifteen years. | Authoritative statutory requirement |
| Salla Developer Platform | Orders, Webhooks, and Partners API (Official Documentation) | Specifies OAuth authorization, fourteen-day access token lifespans, single-use refresh token exchange, order status notifications, and shipping fulfillment webhooks. | Authoritative platform specification |

## 2. Competitive Matrix Comparison

| Capability | Salla Native ZATCA App | Daftra or Qoyod Connectors | Wafeq Accounting | ZATCA-Salla Bridge |
| --- | --- | --- | --- | --- |
| Target Merchant | Basic single-branch B2C stores | General merchants wanting full ERP | Small businesses needing accounting | High-volume, multi-branch, and B2B stores |
| Multi-Branch EGS Routing | Single default branch only | Manual branch assignment in ERP | Manual branch mapping | Automatic POS and branch resolution per order |
| COD Tax Point Timing | Emits invoice upon order execution | Emits upon order execution | Emits upon invoice creation | Holds until carrier handover or delivery |
| B2B Address Gate | Rejects or emits without 6-part check | Fails in background or blocks order | Validates manually in invoice editor | Automatic hold queue and enrichment portal |
| Partial Refunds (381) | Manual credit note generation | Generates credit note in ERP | Manual credit note generation | Automatic proportional 381 credit note |
| Chain Self-Healing | None; requires manual intervention | None; halts sequence on error | None; halts sequence on error | Monotonic ICV lock and linear hash recovery |
| VAT Return Reconciliation | Basic order export | Standard accounting reports | Full VAT return report | Direct Box 1 to Box 5 allocation breakdown |
| System Footprint | Embedded in store control panel | Full accounting and inventory suite | Cloud accounting suite | Pure tax operations engine |

## 3. Merchant and Accountant Field Evidence

Field research across merchant forums and developer issue trackers surfaced four operational patterns:

| Operational Pattern | Primary Field Source | Underlying Cause | Statutory or Merchant Impact | Validation Level |
| --- | --- | --- | --- | --- |
| Premature Tax Points on Unpaid COD Shipments | Salla Merchant Community discussions and accounting advisory forums | Native plugins emit invoices immediately when orders change to in-progress, prior to delivery or receipt of payment. | Merchants incur statutory tax liabilities on orders that buyers subsequently refuse or cancel during shipping. | Confirmed against GCC VAT Agreement Article 23. Merchant return rates vary by vertical. |
| Incomplete National Addresses Halting B2B Clearance | ZATCA Fatoora Discourse Developer Community (Issue logs for BR-KSA-09 and BR-KSA-63) | Standard consumer storefront checkouts omit postal code, building number, and district fields required for business buyers. | Incomplete buyer data causes immediate ZATCA rejection, blocking invoice clearance and delaying shipment dispatch. | Confirmed against official ZATCA validation rules. |
| Token Invalidation Under Concurrent Refresh | Salla Partner Support notes and developer incident reports | Salla OAuth refresh tokens expire upon single use. Clustered workers refreshing tokens simultaneously cause authentication revocation. | Background workers lose API access, stopping invoice generation until the store owner re-authorizes the application manually. | Confirmed against Salla OAuth specification. |
| Duplicate Customer Alerts During Invoice Replacement | ZATCA Detailed Technical Guidelines, pages 71 to 72 | Simplified invoices rejected during the reporting window require new UUIDs and counter values upon correction. | Generic retry workflows resend notifications to customers who already received their physical delivery receipts. | Confirmed against official ZATCA guideline requirements. |

## 4. Open Validation Points for Field Pilot

Field testing with initial merchant cohorts will measure three operational metrics:

Pricing preference will be evaluated by comparing fixed monthly software subscriptions against per-invoice billing tiers.

Accounting coexistence will determine how many stores use external accounting packages alongside our dedicated tax bridge.

Carrier integration workflows will measure whether merchants rely on Salla Shipping services or maintain independent courier contracts.
