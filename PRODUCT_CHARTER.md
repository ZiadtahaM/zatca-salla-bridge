# Product Charter: ZATCA-Salla Tax Operations and Reliability Platform

## 1. Product Identity

Product Name: ZATCA-Salla Tax Operations and Reliability Platform  
Target Segment: High-volume, multi-branch, and B2B Saudi e-commerce merchants operating on Salla and Zid  
Core Hypothesis: Every eligible tax-relevant commerce event receives the correct tax treatment, exactly one authoritative tax document where required, an audited ZATCA outcome within statutory deadlines, and a safe recovery path when upstream or network failures occur.

## 2. Customer Profile and Ideal Customer Profile (ICP)

The primary customer is a Saudi enterprise or mid-market merchant on Salla or Zid characterized by:
- Monthly order volume exceeding 1,000 orders across B2C and B2B streams.
- Hybrid payment methods including Cash on Delivery (COD), unverified bank transfers, and instant card checkouts.
- Multi-branch logistics or omnichannel presence requiring branch-specific VAT/CRN attribution and independent cryptographic EGS units.
- Frequent partial returns, order cancellations, and customer discounts requiring mathematically sound Credit Notes (381) compliant with ZATCA Article 40 and Article 54.
- In-house or external tax accountants who require structured VAT Return Box 1 through Box 5 reconciliations and cannot tolerate audit discrepancies, phantom invoices, or broken PIH cryptographic chains.

Secondary customer:
- Accounting and tax advisory firms managing e-commerce compliance for multiple client stores who need an unalterable audit trail and automated discrepancy detection without manual CSV spreadsheet manipulation.

## 3. The Core Evidenced Problem

Merchants using native marketplace connectors face structural operational traps:
1. Native marketplace connectors issue tax invoices upon simple order execution status changes, ignoring the GCC Unified VAT Agreement Article 23 tax point rules for Cash on Delivery and deferred bank transfers. This inflates tax liabilities on returned or undelivered goods.
2. ZATCA Phase 2 requires strict linear cryptographic chaining (PIH) and monotonically increasing Invoice Counter Values (ICV). When an API timeout, Cloudflare rate limit, or reporting rejection occurs, native tools either halt completely or skip sequence numbers, risking severe non-compliance penalties under the Saudi VAT Law.
3. B2B corporate buyers often place orders without providing full 6-part Saudi National Addresses (building number, street, district, city, postal code, VAT/CRN). Native connectors submit these malformed orders to ZATCA, receiving hard clearance rejections (BR-KSA-09, BR-KSA-63).
4. Partial refunds are either ignored or handled via unlinked manual credit notes, breaking transaction traceability and making VAT audits contentious.

## 4. Target Outcome and Success Metrics

Primary Metric:
The percentage of eligible tax-relevant commerce events that result in exactly one correct tax document where required, with an authoritative ZATCA outcome within the applicable legal deadline and zero unresolved reconciliation discrepancies.

Target operational thresholds:
- Zero duplicate tax documents generated per source order.
- Zero burned or skipped ICV counters within any EGS cryptographic sequence.
- Zero unchained or broken Previous Invoice Hashes (PIH).
- 100 percent of B2C simplified tax invoices reported within 24 hours of supply.
- 100 percent of B2B tax invoices cleared before customer distribution.
- Zero synthetic or guessed customer/item fallback data in recovery paths.

## 5. Scope Boundaries

In Scope:
- Ingestion and durable queueing of Salla and Zid webhook events.
- Statutory tax point evaluation based on payment verification and carrier handover.
- Cryptographic UBL 2.1 XML generation, XAdES-BES signing, and TLV QR generation.
- Real-time ZATCA Phase 2 clearance (B2B) and reporting (B2C) API integration.
- Deterministic retry handling with exponential backoff and dead-letter queues.
- Merchant self-service web portal for B2B address enrichment, PDF/A-3 retrieval, and certificate renewals.
- Continuous reconciliation engine comparing Salla order history against local invoices.
- Quarterly accountant exports with exact VAT Return Box 1 to Box 5 allocation.

Explicit Exclusions:
- General ledger, accounts payable, and double-entry bookkeeping (out of scope).
- Inventory tracking, warehouse management, and stock reordering (out of scope).
- Payroll, employee management, and corporate HR (out of scope).
- Customer relationship management (CRM) and marketing automation (out of scope).
- Shipping label generation, carrier rate shopping, and route optimization (out of scope).
- Cash on Delivery cash collection reconciliation (out of scope).

## 6. Unresolved Assumptions and Dependencies

1. Salla App Store Partner verification requires non-Saudi individual or Saudi entity commercial registration and verified IBAN before public listing approval.
2. ZATCA production CSID issuance requires active taxpayer portal credentials and one-time password (OTP) generated from the taxpayer Fatoora portal.
3. Network availability of ZATCA production endpoints is outside platform control; local ledger persistence and HTTP 303/DLQ fallback are required to guarantee continuity.
