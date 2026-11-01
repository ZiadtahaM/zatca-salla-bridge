# Legal and Statutory Compliance Framework

## 1. Saudi Personal Data Protection Law (PDPL)
- **Governing Law**: Promulgated under Royal Decree No. M/19 dated 9/2/1443H, as amended by Royal Decree No. M/148 dated 5/9/1444H.
- **Supervisory Authority**: Saudi Data & Artificial Intelligence Authority (SDAIA).
- **Service Classification**: The ZATCA-Salla Bridge operates strictly as a **Data Processor** on behalf of the merchant (**Data Controller**).
- **Personal Data Handled**: Customer name, phone number, shipping address, and corporate VAT identifiers strictly required for tax invoice issuance under ZATCA Phase 2.
- **Security Safeguards**:
  - Tenant isolation enforced at the database layer via composite keys (`merchant_id`, `egs_unit_id`).
  - Sensitive credentials (private keys, CSID secrets, OAuth tokens) are encrypted with AES-256-GCM using isolated keys.
  - Sensitive fields in logs and support diagnostics are permanently redacted.
  - Zero cross-tenant data leakage: requests are authenticated using cryptographic HMAC-SHA256 session tokens.

## 2. Saudi VAT Implementing Regulations — Key Provisions

### Article 53: Tax Invoices & Advance Payments
- **Timing of Issuance (Article 53(7)(b))**: For Simplified Tax Invoices (B2C), invoices are due on the earlier of the supply of goods/services or receipt of consideration (including advance payments). Online payments trigger invoice issuance immediately upon payment confirmation.
- **Advance Payment Invoices (Code 386)**: When an advance deposit or down payment is collected before supply, an Advance Payment Invoice (`InvoiceTypeCode 386`) must be issued.
- **Subsequent Final Invoices (Code 388)**: When final supply is made, the final invoice (`388`) must reference the advance invoice in `<cac:AdditionalDocumentReference>` with `BT-1` (IRN), `BT-2` (Date), `KSA-25` (Time), `KSA-30 = 386`, deduct `<cbc:PrepaidAmount>` (`BT-113`), and provide VAT category breakdown (`KSA-31`, `KSA-32`, `KSA-33`, `KSA-34`), calculating `PayableAmount = TaxInclusiveAmount - PrepaidAmount` (`BR-CO-16`).

### Article 53(3): Third-Party Invoicing on Behalf of a Taxable Person
- **Legal Scope**: Allows a taxable person (the merchant) to issue tax invoices through a third party (the integration platform or software provider), subject to ZATCA conditions.
- **Taxpayer Liability**: The taxable person retains full legal and statutory responsibility for invoice accuracy, timeliness of clearance/reporting, and output VAT declaration to ZATCA.
- **Contractual Mandate**: The merchant terms of service and onboarding flow incorporate an explicit electronic authorization and liability demarcation confirming that the taxpayer authorizes the EGS unit to sign and transmit tax documents in accordance with Article 53(3).

### Article 40: Value of Supply Adjustments
- **Statutory Grounds for Adjustment**:
  - Cancellation of supply after issuance of invoice.
  - Return of goods or refund of consideration (full or partial).
  - Discount or price adjustment granted after supply.
- **Prerequisite**: An adjustment under Article 40 requires that consideration was received or a tax invoice was previously issued. Cancellations occurring prior to supply and prior to consideration receipt do not alter taxable supply value and do not trigger tax documents.

### Article 54: Credit and Debit Notes
- **Credit Notes (Code 381)**: Issued following a qualifying Article 40 downward adjustment where a tax invoice has already been issued.
- **Mandatory References**: Must link to the original tax invoice via `<cac:BillingReference><cac:InvoiceDocumentReference>`, citing original ICV, original UUID, issue date, and explicit reason for return.
- **Partial Adjustments**: Partial refunds generate partial credit notes reflecting the exact reduction in consideration and corresponding output tax, without exceeding the original invoice value.

### Article 66: Records Retention and Archiving
- **Retention Period**: All invoices, credit notes, debit notes, and accounting records must be retained for at least six (6) years from the end of the tax year to which they relate.
- **Language**: Records and invoices must be maintained in Arabic (or bilingual with Arabic).
- **Physical/Electronic Accessibility**: Electronic records must be directly accessible from within the Kingdom of Saudi Arabia to ZATCA auditors upon request.
- **Integrity**: Audit logs and invoice tables are protected with database-level immutable triggers (`trg_audit_logs_immutable`, `trg_invoices_immutable`) preventing tampering, alteration, or deletion.
