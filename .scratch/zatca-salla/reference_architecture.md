# ZATCA Phase 2 & Salla E-Commerce Bridge Reference Architecture
Scope: Canonical Production Benchmark Deconstruction
Sources: GitHub SallaApp/ZATCA and Saleh7/php-zatca-xml

## 1. Production Reference Repositories
- SallaApp/ZATCA (GitHub: SallaApp/ZATCA): Official Salla repository for TLV QR encoding, Tag 1 through 9 BER boundaries, and e-invoicing data structures.
- Saleh7/php-zatca-xml (GitHub: Saleh7/php-zatca-xml): Canonical Phase 2 implementation for UBL 2.1 XML generation, secp256k1 ECDSA certificate generation, and ZATCA clearance and reporting APIs.
- axenda/zatca and wes4m/zatca-xml-js: Node and TypeScript implementations for invoice hashing, canonicalization, and signed XML validation.

## 2. Reverse-Engineered Relational Entities
- MerchantConfig (id, salla_merchant_id, access_token_enc, refresh_token_enc, vat_number, crn, national_address_json, is_active)
- EgsDevice (id, merchant_id, uuid, branch_code, branch_name, csr_pem, private_key_enc, compliance_csid, production_csid, csid_expires_at, is_production)
- InvoiceTransaction (id, egs_device_id, salla_order_id, invoice_counter_value, previous_invoice_hash, current_invoice_hash, xml_signed_payload, qr_code_base64, clearance_status, zatca_response_json, created_at)
- AllowanceChargeRecord (id, invoice_id, charge_indicator, allowance_charge_reason, amount, currency, tax_category, tax_percent)
- PrepaymentReference (id, final_invoice_id, advance_invoice_id, advance_invoice_uuid, prepaid_amount, issue_date)
- WebhookEventLog (id, salla_merchant_id, event_name, payload_hash, hmac_verified, processed_at, status)
- DlqDispatchEntry (id, invoice_id, retry_count, next_retry_at, error_category, last_error_message, is_stalled)

## 3. Public API Contracts
- POST /webhooks/salla: Ingests order.created, order.updated, and order.refunded events. Validates X-Salla-Signature using HMAC-SHA256 with store webhook secret.
- POST /api/egs/onboard: Generates secp256k1 key pair and CSR with ZATCA OID extensions (1.3.6.1.4.1.311.20.2). Submits to ZATCA /compliance API with OTP to receive compliance CSID.
- POST /api/invoices/clearance: Submits signed standard B2B invoice (0100000) to ZATCA /invoices/clearance/single. Returns cleared invoice XML with ZATCA cryptographic stamp.
- POST /api/invoices/reporting: Submits signed simplified B2C invoice (0200000) to ZATCA /invoices/reporting/single within 24 hours of issuance.

## 4. Non-Negotiable Operational Invariants
- Dual TaxTotal in Foreign Currencies (BR-KSA-25): When invoice currency is USD or EUR, the root XML must provide two cac:TaxTotal blocks. The first reflects VAT converted to SAR via the verified exchange rate.
- Export and Non-GCC Buyers (BR-KSA-F-08): Non-Saudi corporate buyers are classified under tax category Z with exemption reason VATEX-SA-32 and scheme ID OTH. Domestic 15-digit VAT number checks are bypassed.
- Digital Vouchers and Gift Cards: Multi-purpose cards remain out of scope at issuance (category O, VATEX-SA-OOS), deferring tax recognition to order redemption.
- Prepayment Deductions (BR-CO-16): Advance invoice code 386 references deduct PrepaidAmount from LegalMonetaryTotal. PayableAmount strictly equals TaxInclusiveAmount minus PrepaidAmount.
- Simplified Invoice 24-Hour Threshold (BR-KSA-98): Invoices submitted later than twenty-four hours after IssueDate trigger statutory warnings.

## 5. Verification Gate Status
- [x] Schema and Type Boundary: Strict TypeScript and Zod schemas across endpoints
- [x] Zero-Mock Persistence: Real SQLite storage engine with migrations
- [x] Cryptographic Invariants: Byte-exact hashing and TLV BER boundaries
- [x] E2E Dispatch: 38 unit and integration tests passing in discourse-2026-edge-cases.test.ts
- [x] Physical Exit Gate: All test suites return exit code 0
