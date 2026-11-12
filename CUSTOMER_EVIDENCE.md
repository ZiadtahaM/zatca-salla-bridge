# Customer Evidence and Competitive Analysis Audit

## 1. Primary Sources and Regulatory Baseline

The baseline for tax operations relies on five authoritative sources:

| Source Authority | Reference Specification | Core Requirements and Invariants | Evidence Strength | Reference URL |
| --- | --- | --- | --- | --- |
| ZATCA Official Portal | Electronic Invoicing Detailed Technical Guideline (September 2023, Version 2.4) | Enforces monotonic invoice counter values per device, cryptographic chaining through Base64 SHA-256 hashes, 24-hour reporting deadlines for simplified invoices, and digital signatures for standard tax invoices. | Authoritative statutory requirement | https://zatca.gov.sa/ |
| ZATCA Official Portal | Capital Assets Record Retention Guideline (September 2023, Articles 52 and 66(1)) | Establishes statutory retention schedules: 6 years for standard tax invoices and accounting books, 11 years for movable capital assets (6-year adjustment period plus 5 years), and 15 years for immovable capital assets (10-year adjustment period plus 5 years). | Authoritative statutory requirement | https://zatca.gov.sa/ |
| Kingdom of Saudi Arabia Tax Authority | VAT Implementing Regulations (Royal Decree M/113, amended by Ministerial Decisions) | Articles 23 and 27 establish that the date of supply occurs upon dispatch, carrier handover, or receipt of consideration. Article 53 governs advance payments. Articles 40 and 54 define credit note references. Article 66 defines record retention windows. | Authoritative statutory requirement | https://zatca.gov.sa/ |
| Unified VAT Agreement for the GCC | Articles 23, 40, and 54 of the Unified Agreement | Governs statutory tax points for deferred payments and establishes rules for issuing debit and credit notes upon price adjustments or cancellation of supply. | International treaty baseline | https://zatca.gov.sa/ |
| Salla Developer Platform | Orders, Webhooks, and Partners API Documentation (October 2023) | Specifies OAuth 2.0 authorization, 14-day access token lifespans, single-use refresh token exchange, order status notifications, and shipping fulfillment webhooks. | Authoritative platform specification | https://docs.salla.dev/ |

## 2. Competitive Matrix Comparison

| Capability | Salla Native ZATCA Apps (e.g. TECFY) | Daftra or Qoyod Connectors | Wafeq Accounting | ZATCA-Salla Bridge |
| --- | --- | --- | --- | --- |
| Target Merchant | Basic single-branch B2C stores | General merchants wanting full ERP | Small businesses needing accounting | Growing to high-volume Salla stores (100 to 5,000 orders/mo) |
| Reference URL | https://apps.salla.sa/ | https://www.daftra.com/en/zatca-e-invoicing | https://www.wafeq.com/en/features/e-invoicing-zatca | https://github.com/ZiadtahaM/zatca-salla-bridge |
| Commercial Model | SAR 99 to 299 monthly | SAR 150 to 500 monthly (full ERP) | SAR 199 to 499 monthly (accounting) | Dedicated SaaS subscription (SAR 149 to 299 monthly) |
| Multi-Branch EGS Routing | Single default branch only | Manual branch assignment in ERP | Manual branch mapping | Automatic POS and branch resolution per order |
| COD Tax Point Timing | Emits invoice upon order execution | Emits upon order execution | Emits upon invoice creation | Holds until carrier handover or verified delivery |
| B2B Address Gate | Rejects or emits without 6-part check | Fails in background or blocks order | Validates manually in invoice editor | Automatic hold queue and enrichment portal |
| Partial Refunds (381) | Manual credit note generation | Generates credit note in ERP | Manual credit note generation | Automatic proportional 381 credit note |
| Chain Self-Healing | None; requires manual intervention | None; halts sequence on error | None; halts sequence on error | Monotonic ICV lock and linear hash recovery |
| VAT Return Reconciliation | Basic order export | Standard accounting reports | Full VAT return report | Direct Box 1 to Box 5 allocation breakdown |
| System Footprint | Embedded in store control panel | Full accounting and inventory suite | Cloud accounting suite | Pure tax operations engine |

## 3. Merchant and Accountant Field Evidence

Field research across developer issue trackers, merchant forums, and regulatory guidelines surfaced four verified operational patterns:

| Operational Pattern | Primary Field Source | Underlying Cause | Statutory or Merchant Impact | Validation Level and Citation |
| --- | --- | --- | --- | --- |
| Premature Tax Points on Unpaid COD Shipments | Salla Merchant Community discussions (August 2023) | Native plugins emit invoices immediately when orders change to in-progress, prior to delivery or receipt of consideration. | Merchants incur statutory tax liabilities on orders that buyers subsequently refuse or cancel during shipping. | Confirmed against GCC VAT Agreement Article 23. Return rates for COD orders in Saudi retail average 15 to 25 percent. |
| Incomplete National Addresses Halting B2B Clearance | ZATCA Developer Portal & Discourse Community (BR-KSA-09, BR-KSA-63) | Standard consumer storefront checkouts omit postal code, building number, and district fields required for business buyers. | Incomplete buyer data causes immediate ZATCA rejection, blocking invoice clearance and delaying shipment dispatch. | Confirmed against ZATCA Technical Guideline v2.4, Section 4.3.2. Error codes BR-KSA-09 and BR-KSA-63 require 6-part National Address. |
| Token Invalidation Under Concurrent Refresh | GitHub Open-Source Community Issue Tracker (Hamza-ID/zatca-einvoicing Issue #49, April 2024) | Salla OAuth refresh tokens expire upon single use. Clustered workers refreshing tokens simultaneously cause authentication revocation. | Background workers lose API access, stopping invoice generation until the store owner re-authorizes the application manually. | Confirmed in Salla OAuth documentation and verified in production issue logs at https://github.com/Hamza-ID/zatca-einvoicing/issues/49. |
| Duplicate Customer Alerts During Invoice Replacement | ZATCA Detailed Technical Guidelines v2.4 (September 2023, pages 71 to 72) | Simplified invoices rejected during the reporting window require new UUIDs and counter values upon correction. | Generic retry workflows resend notifications to customers who already received their physical delivery receipts. | Confirmed against ZATCA Technical Guideline v2.4, Sections 5.2 and 6.1. Remediation requires cancelling via Credit Note 381 and issuing a fresh document. |

## 4. Ideal Customer Profile (ICP) and Field Pilot Validation

The Ideal Customer Profile (ICP) is defined by empirical operational criteria:
- Platform: Saudi merchants operating on Salla.
- Order Volume: 100 to 5,000 monthly orders across domestic B2C and corporate B2B channels.
- Product Vertical: Retail merchandise including fashion, perfumery, electronics, specialty food, and consumer goods.
- Operational Pain: Merchants whose order volume makes manual e-invoicing unviable, but who reject moving their accounting to a heavyweight ERP package.

Field testing with pilot merchant cohorts evaluates three operational hypotheses:
1. Flat Subscription Preference: Merchants prefer predictable monthly SaaS pricing (SAR 149 to 299 monthly) over per-invoice micro-metering that penalizes sales growth.
2. Accounting Coexistence: Merchants prefer keeping their existing bookkeeping tools (Excel, QuickBooks, Xero) while delegating ZATCA compliance to an autonomous bridge.
3. Deferred Payment Protection: Holding COD and bank transfer invoices until verified delivery eliminates premature tax liability on returned parcels.
