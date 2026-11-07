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

## 2. Saudi VAT Implementing Regulations & GCC Unified VAT Agreement

### Date of Supply & Tax Point
- **GCC Unified VAT Agreement Article 23(1)**: VAT becomes due on the earliest applicable date of supply of goods/services, issuance of the tax invoice, or partial/full receipt of consideration, to the extent of the amount received.
- **GCC Unified VAT Agreement Article 23(2)(b) & Saudi VAT Implementing Regulations Article 27**: For supplies of goods involving transportation or dispatch, the applicable date of supply is when transportation or dispatch begins.
- **Saudi VAT Implementing Regulations Article 53(1)(a)(2) & Article 53(7)(a)(2)/(b)**: Establishes invoice-issuance requirements for consideration received before supply. Online prepaid orders trigger immediate tax invoice issuance. For Cash on Delivery orders, invoice issuance is deferred until transportation commences (Article 27) or physical delivery is completed.
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
- **Credit Notes (Code 381)**: Governed by Article 54, issued following a qualifying Article 40 downward adjustment where a tax invoice has already been issued.
- **Mandatory References**: Must link to the original tax invoice via `<cac:BillingReference><cac:InvoiceDocumentReference>`, citing original ICV, original UUID, issue date, and explicit reason for return.
- **Partial Adjustments**: Partial refunds generate partial credit notes reflecting the exact reduction in consideration and corresponding output tax, without exceeding the original invoice value.

### ZATCA E-Invoicing Technical Guidelines: Reporting Timeline & Recovery
- **24-Hour Reporting Window**: Established by ZATCA E-Invoicing Integration Requirements and Detailed Technical Guidelines (not Article 53). Simplified tax invoices must be reported to FATOORA within 24 hours of issuance.
- **Technical Reporting Rejection**: Under ZATCA published FAQs, if a simplified invoice is rejected upon reporting, the taxpayer corrects the error and resubmits the document for reporting; no duplicate invoice is issued to the buyer.
- **Permanent Rejection (NOT_REPORTED)**: Under ZATCA FAQ, an invoice returning `NOT_REPORTED` is deemed invalid; the taxpayer cancels it via Credit Note (381) and generates a replacement invoice.
- **Standard B2B Clearance Rejection**: Pre-issuance gate; rejected invoices are never delivered to buyers. Correction requires submitting a new invoice for clearance with fresh UUID, ICV, timestamp, and preceding document PIH.
- **VAT Return Inclusion Invariant**: Technical failure or rejection in FATOORA reporting does not extinguish underlying VAT liability. All issued transactions must be included in the VAT return (Box 1) for the tax period.

### Article 66: Records Retention and Archiving
- **Retention Period (Article 66(1))**: All invoices, credit notes, debit notes, and accounting records must be retained for at least six (6) years from the end of the relevant tax period (month or quarter) to which they relate.
- **Capital Assets**: Retention is required for the statutory adjustment period (10 years for tangible capital assets, 6 years for others) plus five (5) additional years from the date of acquisition.
- **Language**: Records and invoices must be maintained in Arabic (or bilingual with Arabic).
- **In-Kingdom Terminal Access (Article 66(3))**: Electronic records must be accessible and producible upon request through an appropriate terminal or access point located in Saudi Arabia.
- **Integrity**: Audit logs and invoice tables are protected with database-level immutable triggers (`trg_audit_logs_immutable`, `trg_invoices_immutable`) preventing tampering, alteration, or deletion.
