# ZATCA Phase 2 Master Specification (Compiled from NotebookLM)
Notebook ID: 96f71d9d-7eae-42ff-b3f3-792c06cdf2f1
Sources: 52

### 1. Mandatory UBL 2.1 Elements (KSA Profile)

ZATCA Phase 2 defines an electronic invoice profile built upon OASIS UBL 2.1 with specific Kingdom of Saudi Arabia (KSA) extensions [1-3]. Invoices are submitted as raw XML (or embedded in PDF/A-3) [1, 4]:

* **Root Document Header:**
  * `<cbc:ProfileID>`: Declares transaction profile (`reporting:1.0` for Simplified/B2C, or `standard:1.0` for Standard/B2B) [3, 5].
  * `<cbc:ID>`: Sequential business invoice identifier [5].
  * `<cbc:UUID>`: Universally unique identifier (UUID v4) generated dynamically per invoice [5-7]. Reusing UUIDs across invoices triggers duplicate rejection [6].
  * `<cbc:IssueDate>`: Date of issuance formatted as `YYYY-MM-DD` [5, 8].
  * `<cbc:IssueTime>`: Time of issuance formatted as `HH:mm:ss` or `HH:mm:ssZ` [5, 8, 9]. Must synchronize with the date/time stamped in the QR code and signature [8-10].
  * `<cbc:InvoiceTypeCode name="NNNNNNN">388</cbc:InvoiceTypeCode>`:
    * Code `388` for standard/simplified tax invoice, `381` for credit note, `383` for debit note [5, 11-13].
    * Sub-type attribute `name` specifies invoice functional capability flags (e.g., `0100000` for Standard B2B, `0200000` for Simplified B2C) [5, 11, 12].
  * `<cbc:DocumentCurrencyCode>` and `<cbc:TaxCurrencyCode>`: Transaction currency (`SAR`) [5].

* **KSA Custom Extension Components (`cac:AdditionalDocumentReference`):**
  * **Invoice Counter Value (ICV):**
    ```xml
    <cac:AdditionalDocumentReference>
      <cbc:ID>ICV</cbc:ID>
      <cbc:UUID>1</cbc:UUID>
    </cac:AdditionalDocumentReference>
    ```
    Must be a strictly sequential integer per EGS unit with zero gaps [5, 14, 15].
  * **Previous Invoice Hash (PIH):**
    ```xml
    <cac:AdditionalDocumentReference>
      <cbc:ID>PIH</cbc:ID>
      <cac:Attachment>
        <cac:EmbeddedDocumentBinaryObject mimeCode="text/plain">BASE64_PREVIOUS_HASH</cac:EmbeddedDocumentBinaryObject>
      </cac:Attachment>
    </cac:AdditionalDocumentReference>
    ```
    Carries the Base64 SHA-256 digest of the immediately preceding invoice [3, 5, 7].
  * **QR Code Object (Simplified B2C only):**
    ```xml
    <cac:AdditionalDocumentReference>
      <cbc:ID>QR</cbc:ID>
      <cac:Attachment>
        <cac:EmbeddedDocumentBinaryObject mimeCode="text/plain">BASE64_TLV_STRING</cac:EmbeddedDocumentBinaryObject>
      </cac:Attachment>
    </cac:AdditionalDocumentReference>
    ```
    Mandatory for B2C invoices and their notes before distribution [16-18].

* **Parties and Line Items:**
  * **`<cac:AccountingSupplierParty>`**: Seller legal registration name (`cac:PartyLegalEntity/cbc:RegistrationName`) and 15-digit VAT number starting and ending in `3` (`cac:PartyTaxScheme/cbc:CompanyID`) [8, 12, 19].
  * **`<cac:AccountingCustomerParty>`**: Buyer information (mandatory for Standard B2B, optional for Simplified B2C) [4, 20].
  * **Dual Root `<cac:TaxTotal>` Requirement**: The document root requires two `<cac:TaxTotal>` blocks: one document summary (`<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">...</cbc:TaxAmount></cac:TaxTotal>`) and one broken down by tax subcategory (`<cac:TaxSubtotal>`) [9, 10].
  * **`<cac:LegalMonetaryTotal>`**: Contains `<cbc:TaxInclusiveAmount>`, `<cbc:PayableAmount>`, and `<cbc:TaxExclusiveAmount>` [21].

---

### 2. CSID Onboarding API Endpoints & Payload Schemas

Onboarding binds a specific physical or cloud E-invoicing Generation Solution (EGS) unit to ZATCA via cryptographic credentials [19, 22, 23].

#### Phase A: Generate OTP via Fatoora Portal
* Taxpayers log into ERAD/Fatoora Portal to generate a 6-digit One-Time Password (OTP) [19, 24].
* Valid for **1 hour**; no public API exists to obtain the OTP (must be acquired from the portal) [19, 25]. Up to 100 OTPs can be requested at once [26, 27].

#### Phase B: Compliance CSID (CCSID) Request
* **Endpoint:** `POST /compliance` (Sandbox / Simulation / Production gateway) [13, 22].
* **Headers:**
  * `OTP`: 6-digit portal OTP [28, 29].
  * `Accept-Version`: `V2` [30].
  * `Content-Type`: `application/json` [30].
* **Request Payload:**
  ```json
  {
    "csr": "BASE64_ENCODED_PKCS10_CSR"
  }
  ```
* **CSR Subject DN & SAN Requirements:**
  * Curve: `secp256k1` (OID `1.3.132.0.10`) [31, 32].
  * `CN`: Unique Solution Unit Name or Asset Tracking ID [33, 34].
  * `OU`: Organization Unit (Branch name, or Member TIN for VAT groups) [35-37].
  * `O`: Legal Registered Entity Name [34].
  * `C`: Country (`SA`) [34].
  * `UID`: 15-digit Taxpayer VAT number [34, 38].
  * `title`: Functionality Map (`1000` = Standard B2B only, `0100` = Simplified B2C only, `1100` = Both) [11, 34, 38].
  * `1.3.6.1.4.1.311.20.2` (Certificate Template Name): `TSTZATCA-Code-Signing` (Sandbox), `PREZATCA-Code-Signing` (Simulation), or `ZATCA-Code-Signing` (Production) [13, 39].
* **Response:** Returns `binarySecurityToken` (X.509 Compliance Certificate, Base64), `secret` (API password), and `requestID` [13].

#### Phase C: Mandatory Compliance Checks
* To obtain a Production CSID, the EGS must submit mock invoices using its Compliance CSID over HTTP Basic Auth (`binarySecurityToken` : `secret`) [11, 13, 28].
* Requirements:
  * If invoice type is `1000` or `0100`: Submit 3 compliant documents (Invoice, Credit Note, Debit Note) [11, 12].
  * If invoice type is `1100`: Submit 6 compliance documents (Standard B2B: 388, 381, 383; Simplified B2C: 388, 381, 383) [11, 13].

#### Phase D: Production CSID (PCSID) Request
* **Endpoint:** `POST /production/csids` [13].
* **Headers:** HTTP Basic Auth using Compliance CSID credentials, `Content-Type: application/json` [13].
* **Request Payload:**
  ```json
  {
    "compliance_request_id": "REQUEST_ID_FROM_COMPLIANCE_ENDPOINT"
  }
  ```
* **Response:** Returns the live Production CSID `binarySecurityToken` and API `secret` [13, 19, 40].

#### Phase E: Production CSID Renewal
* **Endpoint:** `PATCH /production/csids` [13].
* **Headers:** `OTP` (fresh 6-digit OTP from portal), HTTP Basic Auth with existing PCSID [13].
* **Request Payload:** New CSR Base64 [13].
* **Logic:** Revokes old certificate and returns a fresh PCSID **without resetting** `current_icv` or `last_document_hash` [13, 41, 42].

---

### 3. Cryptographic Signing Rules (secp256k1 ECDSA & XAdES-BES)

All cryptographic signing follows the ZATCA Detailed Technical Guideline (Section 5.2) [2, 43]:

```
+-------------------------------------------------------------------------------------------------------+
| 1. Purge & Canonicalize   ==>  2. SHA-256 Digest  ==>  3. ECDSA Sign  ==>  4. Linearized XAdES-BES    |
| (Strip UBLExtensions,          (Generate 32-byte       (secp256k1 over      (Embed DigestValue,       |
| cac:Signature, QR block;        digest & Base64         raw invoice hash     SignatureValue, & cert;  |
| canonicalize with C14N 1.1)     for XML reference)      into ds:SigValue)    byte-identical embed)    |
+-------------------------------------------------------------------------------------------------------+
```

1. **Tag Stripping for Step 1 Hash:**
   * Parse the full UBL XML and remove:
     * `ext:UBLExtensions` (`//*[local-name()='UBLExtensions']`) [17].
     * `cac:Signature` (`//*[local-name()='Signature']`) [17].
     * QR Document Reference (`//*[local-name()='AdditionalDocumentReference'][cbc:ID[normalize-space(text())='QR']]`) [17].
   * Strip the XML declaration (`<?xml version="1.0" ... ?>`) [44-46].
2. **Canonicalization:**
   * Canonicalize the stripped invoice using W3C Canonical XML 1.1 (`C14N11`) [44, 47].
3. **Step 1 Invoice Hash Calculation:**
   * Hash the canonicalized invoice body using **SHA-256** to yield a 32-byte raw binary digest [44, 46, 48].
   * Encode to Base64 (44 characters); this is populated into `<ds:Reference Id="invoiceSignedData"><ds:DigestValue>` and QR Tag 6 [31, 44, 49, 50].
4. **Step 2 ECDSA Digital Signature:**
   * Sign the **raw 32-byte SHA-256 invoice hash digest** using the `secp256k1` private key with ECDSA [9, 31, 51, 52].
   * **Do not double-hash** (e.g., passing pre-hashed bytes into an API that hashes again triggers `Wrong signature value`) [10, 47].
   * Base64-encode the resulting ASN.1 DER signature; inject into `<ds:SignatureValue>` [31, 50, 51].
5. **Step 3 Certificate Hashing:**
   * Hash the DER-encoded X.509 certificate with SHA-256 [51].
   * Convert the hash to a 64-character lowercase hexadecimal string, then Base64-encode that hex string (producing an 88-character Base64 string); inject into `<xades:SigningCertificate><xades:CertDigest><ds:DigestValue>` [51, 53, 54].
6. **Step 4 & 5 Linearized SignedProperties:**
   * Create `<xades:SignedProperties Id="xadesSignedProperties">` containing `<xades:SigningTime>` (matching `<cbc:IssueDate>` and `<cbc:IssueTime>`) and `<xades:SigningCertificate>` [9, 55, 56].
   * **Linearize the block with zero whitespace or newlines between tags** before hashing [10, 48, 57].
   * Compute SHA-256 hex digest, Base64-encode it, and populate into `<ds:Reference URI="#xadesSignedProperties"><ds:DigestValue>` [48, 57].
7. **Step 6 Injection:**
   * Inject `<ext:UBLExtensions>` and `<cac:Signature>` adjacent to target tags without injecting surrounding phantom whitespace or newlines, guaranteeing that subsequent XPath stripping produces byte-for-byte identical output to Step 1 [17, 31, 58, 59].

---

### 4. TLV QR Code Structure (Tags 1 to 9 & Byte Constraints)

The QR code is a Tag-Length-Value (TLV) encoded string, converted to Base64, with a maximum length of **700 characters** [54, 60, 61]. For each tag:
* **Tag (T):** 1 byte (integer 1 to 9) [8, 54, 61].
* **Length (L):** 1 byte representing the UTF-8 byte length of the value [54, 61, 62].
* **Value (V):** Raw bytes of the field value [54, 61].

| Tag | Name | Description & Specification | Type / Encoding | Byte Limits / Constraints |
|---|---|---|---|---|
| **1** | Seller's Name | Seller legal name matching VAT certificate [8, 63] | UTF-8 String (NFC normalized) [7, 54, 63] | Variable (≤ 127 bytes) [53, 54] |
| **2** | VAT Registration Number | 15-digit VAT number (starts/ends with 3) [8, 12, 63] | ASCII / UTF-8 String [54, 63] | Exactly 15 bytes [63] |
| **3** | Invoice Timestamp | Invoice issue date and time [8, 49] | Combined ISO-8601 (`YYYY-MM-DDTHH:mm:ssZ`) [8, 9, 49] | Exactly 20 bytes [9, 49] |
| **4** | Invoice Total | Total invoice amount including VAT [21, 49] | ASCII decimal text (e.g., `1108.90`) [49, 54] | Variable (≤ 127 bytes) [53, 54] |
| **5** | VAT Total | Total VAT amount across all lines [21, 49] | ASCII decimal text (e.g., `114.90`) [49, 54] | Variable (≤ 127 bytes) [53, 54] |
| **6** | Invoice Hash | Base64 SHA-256 invoice body digest from Step 1 [21, 49, 54] | UTF-8 of Base64 string [49, 54] | Exactly 44 bytes [49, 64] |
| **7** | ECDSA Signature | Base64 signature string from `<ds:SignatureValue>` [21, 49, 53] | UTF-8 bytes of Base64 signature string [53, 54] | Typically 96 bytes (0x60) [49, 53] |
| **8** | ECDSA Public Key | SubjectPublicKeyInfo (SPKI) DER public key [21, 53, 65] | Raw SPKI DER binary buffer [53, 54] | Exactly 88 bytes (starts `30 56 30 10...`) [53, 65] |
| **9** | CA Signature | ZATCA Technical CA signature of the public key [53, 66, 67] | Raw ASN.1 DER ECDSA signature bytes [53, 54] | 70 to 72 bytes (starts `30 46 02 21...`) [53, 54, 66] |

> **Critical BER Limit:** Under ASN.1 Basic Encoding Rules (BER), single-byte lengths where the high bit is set (`>= 128`, i.e., `0x80`) indicate multi-byte or negative length indicators [53, 63]. **If any single tag exceeds 127 bytes, ZATCA rejects the invoice (`QRCODE_INVALID`)** [53, 54, 68]. Pre-extracting the public key (Tag 8, 88 bytes) and CA signature (Tag 9, 70–72 bytes) from the X.509 certificate ensures all tags remain strictly under 128 bytes [53, 54, 69].

---

### 5. Previous Invoice Hash (PIH) Chaining Logic & Sequencing

To ensure an unbroken, tamper-evident audit ledger, every EGS unit maintains an independent linear chain [15, 70, 71]:

* **Initial Seed (ICV = 1):**
  * The first invoice issued by an EGS unit has `ICV = 1` [5, 7].
  * Its Previous Invoice Hash (PIH) is seeded with the Base64 encoding of the SHA-256 hash of numerical zero: `NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODU...` (the standard ZATCA initial hash string) [5, 7].
* **Subsequent Invoices (`ICV = N`):**
  * `PIH` must equal the exact Base64 SHA-256 invoice body hash of invoice `N - 1` [7, 71, 72].
  * `ICV` increments monotonically by 1 [7, 14].
* **Handling Rejected Submissions (Critical Rule):**
  * If Document 1 is accepted, Document 2 is **rejected** (HTTP 400), and Document 3 is generated:
    * **ZATCA records and stores the hash of rejected documents** [71, 73, 74].
    * **Document 3's PIH must point to the hash of rejected Document 2** [73-75].
    * When Document 2 is corrected and resubmitted as Document 4, **Document 4 gets a fresh UUID, new incremented ICV, and its PIH must point to Document 3** (the latest generated document), while referencing Document 2's identifier in billing references [27, 74, 75].
* **Concurrency Architecture:**
  * Because sequence gaps or out-of-order PIH values cause immediate business-rule rejection (`PIH mismatch`), concurrency must be serialized per physical EGS unit [14, 15, 72].
  * Counter allocation and hash updates should execute inside a single atomic row lock (e.g., PostgreSQL `SELECT ... FOR UPDATE` on `egs_units`) committed strictly during final signature emission [7, 15, 76].

---

### 6. Clearance vs. Reporting Flow

```
                      +------------------------------------------+
                      |         Invoice Generated on EGS         |
                      +------------------------------------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
             [Standard B2B]                                [Simplified B2C]
                    |                                             |
                    v                                             v
       +-------------------------+                   +-------------------------+
       | Send to Clearance API   |                   | Locally Sign & Stamp    |
       | (POST /invoices/        |                   | (secp256k1 + TLV QR)    |
       |  clearance/single)      |                   +-------------------------+
       +-------------------------+                                |
                    |                                             v
        +-----------+-----------+                    +-------------------------+
        |                       |                    | Issue to Consumer at POS|
   [Cleared]               [Rejected]                +-------------------------+
        |                       |                                 |
        v                       v                                 v
+----------------+      +---------------+            +-------------------------+
| Receive stamped|      | Fix errors,   |            | Report to ZATCA within  |
| XML & QR from  |      | advance chain,|            | 24 hours of issuance    |
| ZATCA; issue   |      | resubmit with |            | (POST /invoices/        |
| to buyer       |      | new ICV/date  |            |  reporting/single)      |
+----------------+      +---------------+            +-------------------------+
```

* **Standard Tax Invoices (B2B) — Clearance Model:**
  * **Endpoint:** `POST /invoices/clearance/single` with header `Clearance-Status: 1` [13].
  * **Timing:** Synchronous, real-time pre-issuance [1, 20]. An invoice is legally invalid until cleared [1, 20].
  * **Response:** On HTTP 200 or 202, ZATCA applies its own cryptographic clearance stamp, updates the QR code, and returns the cleared XML in the `clearedInvoice` JSON field [32, 73, 77]. The seller **must store and provide this ZATCA-returned cleared XML** to the buyer [32, 73, 75].
  * **HTTP 303 Fallback:** If ZATCA temporarily disables clearance under high system load, it returns HTTP 303 redirecting standard invoices to the reporting endpoint (where clearance stamping is temporarily suspended) [78-80].

* **Simplified Tax Invoices (B2C) — Reporting Model:**
  * **Endpoint:** `POST /invoices/reporting/single` with header `Clearance-Status: 0` [13].
  * **Timing:** Asynchronous post-issuance [1, 20]. The merchant signs the XML, renders the TLV QR code (Tags 1–9), prints/delivers the invoice immediately to the buyer, and reports the XML to ZATCA **within 24 hours of transaction completion** [1, 16, 20].
  * **Response:** ZATCA validates business rules and stores the invoice, returning an acknowledgment confirmation without restamping [16, 20, 73].

---

### 7. Error Mitigation & Outage Strategies (HTTP 400, 401, 409, 429, 503)

| Status Code / Scenario | Root Cause | Ledger & PIH State Handling | Mitigation & Recovery Pattern |
|---|---|---|---|
| **HTTP 400 / 422** <br>*(Business Rejection)* | Schema invalidity, wrong hash, PIH mismatch, or timestamp skew [2, 79, 81]. | **Chain advances:** ZATCA stores rejected hashes. Status \\(\rightarrow\\) `REJECTED`. Next invoice points to this rejected hash [71, 73, 74, 80]. | Parse `validationResults.errorMessages` [79, 82]. Do not reuse UUID or ICV [6, 27]. Fix data payload, allocate fresh ICV and new UUID, and resubmit [27, 72, 74]. |
| **HTTP 401** <br>*(Unauthorized)* | PCSID has expired, secret was rotated, or certificate was revoked by ZATCA (e.g., VAT group change or suspension) [4, 32, 75, 83]. | **Halt queue:** Do not advance ICV [32, 84]. | Suspend outbound dispatches immediately to avoid wasting consecutive sequential numbers [32, 84]. Alert operator to renew certificate via `PATCH /production/csids` [13, 32]. |
| **HTTP 409 / 400** <br>*(Duplicate UUID / Hash)* | Previous attempt timed out at the gateway (502/504) after ZATCA's backend had already committed the document [30, 85]. | **Do not reject:** The invoice already exists on ZATCA ledger [30]. | Intercept `DUPLICATE_INVOICE` error codes [30]. Treat as idempotent success, mark invoice `REPORTED`/`CLEARED`, or call ZATCA retrieval API to fetch the cleared XML [30]. |
| **HTTP 429** <br>*(Rate Limit)* | Submission frequency exceeded gateway traffic quotas [75, 82]. | **Retain state:** Payload and hash head remain untouched [79]. | Read the `Retry-After` HTTP header [82]. Place invoice in a retry queue with backoff (defaulting to 60s if header is absent) [82]. |
| **HTTP 500 / 502 / 503 / 504** <br>*(Platform Outage)* | ZATCA API downtime, scheduled maintenance, or Nginx timeout (`URL Open error`) [85-87]. | **Preserve hash head:** Transaction did not reach ZATCA business engine [79]. | For B2C: print invoice receipt immediately [79]. Enqueue XML in a Dead Letter Queue (DLQ) with exponential backoff and full jitter: <br>`delay = min(300000, random() * (1000 * 2^attempt))` [79]. Submit intact once platform recovers [79]. |
| **HTTP 403 HTML** <br>*(Cloudflare Edge WAF Block)* | Cloudflare WAF false-positive triggered by default HTTP client User-Agents, IP blocking, or malformed payloads [30, 68, 88, 89]. | **Outage classification:** Treat as network transport barrier [30, 82]. | Check `Content-Type` header before parsing JSON; if `text/html` or contains `Ray ID`, flag as gateway outage [82, 88]. Ensure client sends compliant headers: `Accept: application/json`, `Accept-Version: V2`, `Accept-Language: ar`, and a standard User-Agent [30]. |
