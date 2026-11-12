# Product Charter: ZATCA-Salla Tax Operations Bridge

## 1. Product Identity

Product Name: ZATCA-Salla Tax Operations Bridge  
Target Platform: Salla e-commerce platform for the Phase 1 MVP, with Zid scheduled for Phase 2 post-validation.  
Target Segment: High-growth Saudi merchants on Salla. These businesses process between 100 and 5,000 monthly orders across domestic B2C sales and occasional corporate B2B transactions.  
Core Hypothesis: Every eligible tax-relevant commerce event must receive the correct tax treatment, exactly one authoritative tax document where required by law, an audited ZATCA outcome within statutory deadlines, and an automated recovery path whenever upstream network failures or platform outages occur.

## 2. Customer Profile and Ideal Customer Profile (ICP)

The primary customer is an established Saudi merchant operating on Salla with the following operational profile:
- Monthly order volume ranging from 100 to 5,000 orders across domestic B2C and occasional B2B streams.
- Diverse payment methods including online card checkout through Mada, Visa, Mastercard, and Apple Pay, alongside Cash on Delivery and deferred bank transfers.
- Single-store or multi-branch logistics setups that require branch-specific VAT or CRN attribution and independent cryptographic EGS units.
- Order adjustments, cancellations, and customer returns requiring mathematically sound Credit Notes under ZATCA Article 40 and Article 54.
- In-house or external tax accountants who require structured VAT Return Box 1 through Box 5 reconciliations and cannot tolerate audit discrepancies, phantom invoices, or broken cryptographic chains.
- Explicit preference for a lean tax operations bridge over migrating their entire business operations to an expensive and complex enterprise ERP suite.

Secondary customer:
- Accounting and tax advisory firms. These firms manage e-commerce tax compliance for multiple client stores on Salla and require an unalterable audit trail alongside automated discrepancy detection without manual spreadsheet manipulation.

## 3. The Core Evidenced Problem

Merchants using native marketplace connectors face structural operational traps:
1. Native marketplace connectors issue tax invoices upon simple order execution status changes. They ignore the GCC Unified VAT Agreement Article 23 tax point rules for Cash on Delivery and deferred bank transfers, which inflates tax liabilities on returned or undelivered goods. This premature tax trigger creates real financial exposure for the seller.
2. ZATCA Phase 2 requires strict linear cryptographic chaining (PIH) and monotonically increasing Invoice Counter Values (ICV). When an API timeout, Cloudflare rate limit, or reporting rejection occurs, native tools either halt completely or skip sequence numbers. This sequence disruption risks severe statutory penalties under the Saudi VAT Law. Counters break. Chains fail.
3. B2B corporate buyers often place orders without providing full six-part Saudi National Addresses. Native connectors submit these malformed orders to ZATCA and trigger hard clearance rejections such as BR-KSA-09 and BR-KSA-63. Deliveries stall.
4. Partial refunds are either ignored or handled via unlinked manual credit notes. This bad practice breaks transaction traceability and makes VAT audits contentious. Tax reconciliations fail completely.

## 4. Target Outcome and Success Metrics

Primary Metric:
The percentage of eligible tax-relevant commerce events that result in exactly one correct tax document where required, with an authoritative ZATCA outcome within the applicable legal deadline and zero unresolved reconciliation discrepancies.

Target operational thresholds:
- Zero duplicate tax documents generated per source order.
- Zero burned or skipped ICV counters within any EGS cryptographic sequence.
- Zero unchained or broken Previous Invoice Hashes (PIH).
- 100 percent of B2C simplified tax invoices reported within 24 hours of supply.
- 100 percent of B2B tax invoices cleared before customer distribution.
- Zero synthetic or guessed customer or item fallback data in recovery paths.

Every operational threshold is tracked continuously. Discrepancies halt automated releases immediately without human intervention.

## 5. Scope Boundaries

The Phase 1 release addresses all mandatory operational and cryptographic requirements for domestic commerce on Salla, leaving secondary platforms and corporate ERP integrations for subsequent milestones.

In Scope (Phase 1 MVP):
- Ingestion and durable queueing of Salla webhook events.
- Statutory tax point evaluation based on payment verification and carrier handover.
- Cryptographic UBL 2.1 XML generation, XAdES-BES signing, and TLV QR generation.
- Real-time ZATCA Phase 2 clearance (B2B) and reporting (B2C) API integration.
- Deterministic retry handling with exponential backoff and dead-letter queues.
- Merchant self-service web portal for B2B address enrichment, PDF/A-3 retrieval, and certificate renewals.
- Continuous reconciliation engine comparing Salla order history against local invoices.
- Quarterly accountant exports with exact VAT Return Box 1 to Box 5 allocation.

Phase 2 Scope (Post-MVP):
- Zid platform webhook ingestion adapter and multi-platform merchant account linking.
- Advanced multi-tenant franchise branch aggregation.

Explicit Exclusions:
- General ledger, accounts payable, and double-entry bookkeeping (out of scope).
- Inventory tracking, warehouse management, and stock reordering (out of scope).
- Payroll, employee management, and corporate HR (out of scope).
- Customer relationship management (CRM) and marketing automation (out of scope).
- Shipping label generation, carrier rate shopping, and route optimization (out of scope).
- Cash on Delivery cash collection reconciliation (out of scope).

## 6. Unresolved Assumptions and Dependencies

1. Salla App Store Partner verification requires either a non-Saudi individual or Saudi entity commercial registration alongside a verified IBAN before public listing approval is granted by Salla. Partner approval is mandatory.
2. ZATCA production CSID issuance requires active taxpayer portal credentials. Merchants must generate a one-time password directly from the taxpayer Fatoora portal during onboarding.
3. Network availability of external ZATCA production endpoints remains completely outside platform control. Consequently, local ledger persistence, advisory transaction locks, and dead-letter queue fallbacks are strictly required to guarantee uninterrupted commerce continuity during upstream government portal outages. Zero data loss is permissible.
