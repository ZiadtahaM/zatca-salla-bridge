# ZATCA Phase 2 Resilient E-Invoicing Bridge for Salla and Zid

A production-grade, fault-tolerant e-invoicing bridge connecting Saudi e-commerce stores on Salla and Zid to ZATCA Phase 2 (Fatoora). Enforces monotonic ICV sequence counters, unbroken PIH hash chains, single-pass XAdES-BES signatures, 127-byte single-byte BER TLV QR encoding, and automated 500/502/503/504 outage retry handling with HTTP 303 clearance fallback.

---

## Architecture & System Overview

```
[ Salla Store / App Store ]
       │
       ├── Webhook: app.store.authorize ──> [ POST /webhooks/salla/authorize ] ──> AES-256-GCM Vault ──> merchant_tokens
       │
       └── Webhook: order.* / refund.*  ──> [ POST /webhooks/salla ]
                                                     │
                                            HMAC-SHA256 Verification
                                                     │
                             ┌───────────────────────┴───────────────────────┐
                             │                                               │
                   [ COD / Bank Transfer ]                         [ B2B Buyer Address ]
                             │                                               │
                   Status == completed?                            6-part address complete?
                     ├── No  ──> deferred_payment_hold               ├── No  ──> pending_b2b_orders
                     └── Yes ──> Continue to Signing                 └── Yes ──> POST /api/b2b/orders/:id/enrich
                                                     │
                                            [ Branch / POS Router ]
                                                     │
                                     SELECT ... FOR UPDATE on egs_units
                                                     │
                                   [ XML Canonicalization & Signer ]
                                    - <cac:AllowanceCharge> Math
                                    - Single-Pass secp256k1 ECDSA
                                    - Linearized SignedProperties
                                    - 9-Tag TLV QR Buffer (<= 700 chars)
                                                     │
                                  [ ZATCA Outage & Clearance Gateway ]
                                    - Cloudflare-safe headers
                                    - HTTP 409 Duplicate UUID Recovery
                                    - HTTP 303 Reporting Fallback
                                    - Dead Letter Queue (DLQ)
                                                     │
                                  [ PDF/A-3 & Printable HTML Engine ]
                                    - Embedded ZATCA_eInvoice.xml
                                    - Bilingual RTL/LTR Visual Layout
```

---

## Complete API Reference & Endpoints

| Method | Endpoint | Description | Expected Payload / Response |
| --- | --- | --- | --- |
| `GET` | `/health` | Shallow liveness probe | Returns HTTP 200 `{ status: "healthy", timestamp }` |
| `GET` | `/ready` | Deep readiness probe (PostgreSQL check) | Returns HTTP 200 `{ status: "ready", database: "connected" }` |
| `POST` | `/api/egs/onboard` | Merchant EGS Unit onboarding & CSID exchange | Takes merchant VAT, store name, branch, and 6-digit Fatoora OTP. Returns `egs_unit_id` |
| `POST` | `/webhooks/salla/authorize` | Salla App Store OAuth2 token receiver | Stores AES-256-GCM encrypted tokens in `merchant_tokens` |
| `GET` | `/api/salla/merchants/:merchantId/tokens` | Decrypted merchant token status | Returns token status and expiration date |
| `POST` | `/webhooks/salla` | Primary Salla webhook receiver | Ingests `order.created`, `order.updated`, `order.refunded`, `order.cancelled` |
| `POST` | `/api/b2b/orders/:orderId/enrich` | B2B buyer national address enrichment | Accepts building number, postal code, street, district, and city, then signs invoice |
| `GET` | `/api/invoices/:id/pdf` | PDF/A-3 download | Returns binary PDF with embedded `ZATCA_eInvoice.xml` and TLV QR code |
| `GET` | `/api/invoices/:id/printable` | Printable bilingual invoice HTML | Returns RTL/LTR HTML5 invoice with QR code and breakdown |
| `POST` | `/api/validate/preflight` | Pre-flight validator API | Audits raw XML or Salla order JSON against ZATCA rules |
| `GET` | `/debugger` | Bilingual Pre-Flight UI | Interactive web dashboard for merchants and developers |
| `GET` | `/api/ops/csid-status` | CSID expiration monitor | Lists EGS units expiring within 7 days |
| `GET` | `/api/ops/dlq` | Dead Letter Queue monitor | Lists failed invoices stalled for over 30 minutes |
| `POST` | `/api/ops/dlq/:id/resolve` | DLQ manual resolver | Marks a dead-letter entry resolved after manual audit |

---

## Step-by-Step Merchant Onboarding Guide

### Step 1: Generate 6-Digit OTP from Fatoora Portal
1. Merchant logs into the official ZATCA Fatoora Portal:
   - Sandbox / Simulation: `https://fatoora.zatca.gov.sa/`
   - Production: `https://fatoora.zatca.gov.sa/`
2. Navigate to **Onboarding Solution Devices** -> **Generate OTP**.
3. Copy the 6-digit numeric OTP (valid for 60 minutes).

### Step 2: Call the Onboarding API
Send a POST request to `/api/egs/onboard`:

```bash
curl -X POST http://localhost:3000/api/egs/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "merchantId": "1002345",
    "branchId": "riyadh_main",
    "storeName": "شركة رواء للملابس الفاخرة",
    "vatNumber": "300075588700003",
    "otp": "123456",
    "isProduction": false
  }'
```

**Response:**
```json
{
  "status": "onboarded",
  "egs_unit_id": "e739ba62-45ba-4f42-b48c-727302355928",
  "customId": "POS-riyadh_main-01",
  "environment": "compliance",
  "expires_at": "2027-10-21T14:00:00.000Z"
}
```

What happens under the hood during onboarding:
1. Generates a fresh `secp256k1` EC private key and cryptographic CSR containing ZATCA OIDs (`1.3.6.1.4.1.311.20.2`, `1.3.6.1.4.1.311.21.1`, `1.3.6.1.4.1.311.21.7`).
2. Calls Fatoora API with OTP to receive Compliance CSID (`binarySecurityToken` + secret).
3. Executes compliance checks (Standard invoice, Simplified invoice, Credit note).
4. Reconstructs certificate with 64-character PEM line wrapping and extracts ASN.1 CA signatures.
5. Encrypts the private key and CSID secret with AES-256-GCM (`v1:` envelope) and stores them in `egs_units`.
6. Purges all temporary key files from the filesystem in a `finally` block.

---

### Step 3: Connect Salla App Store OAuth
When a merchant clicks "Install App" on the Salla App Store, Salla dispatches the `app.store.authorize` webhook to your server:

```bash
curl -X POST http://localhost:3000/webhooks/salla/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "event": "app.store.authorize",
    "merchant": "1002345",
    "created_at": "2026-10-21 12:00:00",
    "data": {
      "access_token": "salla_oauth_access_token_xyz",
      "refresh_token": "salla_oauth_refresh_token_abc",
      "expires_in": 1209600,
      "scope": "offline_access"
    }
  }'
```

The tokens are encrypted via AES-256-GCM and stored in the `merchant_tokens` table.

---

## Webhook Payloads & Real-World Gates

### 1. Standard B2C Order (`order.created` with Discount & Shipping)
Discounts are serialized with `<cbc:ChargeIndicator>false</cbc:ChargeIndicator>`, and shipping plus COD charges with `<cbc:ChargeIndicator>true</cbc:ChargeIndicator>`.

```bash
curl -X POST http://localhost:3000/webhooks/salla \
  -H "Content-Type: application/json" \
  -H "x-salla-signature: <HMAC_SHA256_HEX>" \
  -d '{
    "event": "order.created",
    "merchant": "1002345",
    "created_at": "2026-10-21T14:00:00Z",
    "data": {
      "id": 998811,
      "reference_id": "ORD-998811",
      "date": { "date": "2026-10-21 14:00:00", "timezone": "Asia/Riyadh" },
      "status": { "id": 1, "name": "Under Review", "slug": "under_review" },
      "payment_method": "credit_card",
      "currency": "SAR",
      "amounts": {
        "sub_total": { "amount": 200.00, "currency": "SAR" },
        "discounts": { "amount": 20.00, "currency": "SAR" },
        "shipping_cost": { "amount": 15.00, "currency": "SAR" },
        "cash_on_delivery": { "amount": 5.00, "currency": "SAR" },
        "tax": { "amount": { "amount": 30.00, "currency": "SAR" }, "percent": 15 },
        "total": { "amount": 230.00, "currency": "SAR" }
      },
      "customer": {
        "id": 501,
        "first_name": "سلمان",
        "last_name": "العتيبي",
        "tax_number": null
      },
      "items": [
        {
          "id": 1,
          "name": "ثوب رسمي فاخر",
          "quantity": 1,
          "price": { "amount": 200.00, "currency": "SAR" },
          "total": { "amount": 200.00, "currency": "SAR" }
        }
      ]
    }
  }'
```

---

### 2. B2B Corporate Order & National Address Enrichment
If `customer.tax_number` is a 15-digit Saudi VAT number (`3XXXXXXXXXXXXX3`), but the shipping address lacks 4-digit building number, 5-digit postal code, or district:
- The system returns `status: "pending_b2b_enrichment"` and missing fields list.
- **Zero ICV burn:** The database row lock on `egs_units` is NOT acquired.
- The order is stored in `pending_b2b_orders`.

**Enrichment Request (`POST /api/b2b/orders/:orderId/enrich`):**
```bash
curl -X POST http://localhost:3000/api/b2b/orders/998811/enrich \
  -H "Content-Type: application/json" \
  -d '{
    "building_number": "4321",
    "postal_code": "12244",
    "street": "King Fahd Road",
    "district": "Al-Olaya",
    "city": "Riyadh",
    "company_name": "شركة المشتري للتجارة"
  }'
```

**Response:**
Returns HTTP 200 `status: "enriched_and_signed"` with Standard Tax Invoice (`0100000`) and assigned ICV.

---

### 3. COD & Bank Transfer Status Gate
If `payment_method` is `cod`, `cash_on_delivery`, `bank`, or `bank_transfer`:
- When status is `under_review` or `in_progress`, returns `status: "deferred_payment_hold"`.
- When an `order.updated` webhook arrives with status `completed` or `delivered`, the invoice is signed and assigned an ICV.
- Subsequent updates return `status: "idempotent_replay"`, preventing duplicate ICV burn.

---

### 4. Refund / Credit Note 381
When an `order.refunded` or `order.cancelled` webhook arrives:
- Queries the original invoice UUID and ICV from `invoices`.
- Generates a UBL 2.1 Credit Note 381 containing `<cac:BillingReference>` pointing to the original document.
- Advances the ICV and PIH hash chain.

---

## Database Schema & Tables

All persistence runs in PostgreSQL. Check constraints enforce AES-256-GCM encryption at rest under Saudi PDPL Law 151/2020.

```sql
-- Physical Cryptographic Devices & Stamp Chains
CREATE TABLE egs_units (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id VARCHAR(64) NOT NULL,
    branch_id VARCHAR(64) NOT NULL,
    salla_branch_id VARCHAR(64),
    terminal_id VARCHAR(64),
    egs_uuid UUID NOT NULL UNIQUE,
    custom_id VARCHAR(100) NOT NULL,
    model VARCHAR(100) NOT NULL,
    csid_environment csid_environment_enum NOT NULL DEFAULT 'production',
    certificate TEXT NOT NULL,
    certificate_hash VARCHAR(128) NOT NULL,
    public_key_bytes BYTEA NOT NULL,
    ca_signature_bytes BYTEA NOT NULL,
    private_key_pem TEXT NOT NULL,
    csid_secret TEXT NOT NULL,
    current_icv BIGINT NOT NULL DEFAULT 0,
    last_document_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    renewal_status VARCHAR(32) NOT NULL DEFAULT 'active',
    last_renewal_alert_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_merchant_branch_unit UNIQUE (merchant_id, branch_id, custom_id),
    CONSTRAINT chk_egs_encrypted_key CHECK (private_key_pem LIKE 'v1:%'),
    CONSTRAINT chk_egs_encrypted_secret CHECK (csid_secret LIKE 'v1:%')
);

-- Immutable Append-Only Invoice Ledger
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    egs_unit_id UUID NOT NULL REFERENCES egs_units(id) ON DELETE RESTRICT,
    order_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    invoice_type invoice_type_enum NOT NULL,
    uuid UUID NOT NULL UNIQUE,
    icv BIGINT NOT NULL,
    pih VARCHAR(64) NOT NULL,
    invoice_hash VARCHAR(64) NOT NULL,
    qr_code_payload TEXT NOT NULL,
    signed_xml TEXT NOT NULL,
    cleared_xml TEXT,
    status invoice_status_enum NOT NULL DEFAULT 'draft',
    supply_date DATE NOT NULL,
    issue_timestamp TIMESTAMPTZ NOT NULL,
    replaces_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    subtotal NUMERIC(15, 2) NOT NULL,
    tax_total NUMERIC(15, 2) NOT NULL,
    grand_total NUMERIC(15, 2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'SAR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_egs_icv UNIQUE (egs_unit_id, icv),
    CONSTRAINT uq_egs_invoice_hash UNIQUE (egs_unit_id, invoice_hash)
);

-- Encrypted Merchant OAuth Tokens
CREATE TABLE merchant_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id VARCHAR(64) NOT NULL UNIQUE,
    access_token_encrypted TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    token_scope TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_merchant_access_token CHECK (access_token_encrypted LIKE 'v1:%'),
    CONSTRAINT chk_merchant_refresh_token CHECK (refresh_token_encrypted LIKE 'v1:%')
);

-- B2B Corporate Buyer Hold Queue
CREATE TABLE pending_b2b_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id VARCHAR(64) NOT NULL,
    order_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    egs_unit_id UUID NOT NULL REFERENCES egs_units(id) ON DELETE RESTRICT,
    buyer_vat VARCHAR(15) NOT NULL,
    buyer_name VARCHAR(255) NOT NULL,
    order_payload JSONB NOT NULL,
    missing_fields JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending_enrichment',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Log & Dead Letter Queue (DLQ)
CREATE TABLE zatca_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    http_status_code INTEGER NOT NULL,
    response_content_type VARCHAR(128) NOT NULL,
    raw_response TEXT,
    parsed_response JSONB,
    is_outage_error BOOLEAN NOT NULL DEFAULT FALSE,
    submission_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE zatca_dlq (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    merchant_id VARCHAR(64) NOT NULL,
    egs_unit_id UUID NOT NULL REFERENCES egs_units(id) ON DELETE CASCADE,
    failure_reason TEXT NOT NULL,
    http_status INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_stalled BOOLEAN NOT NULL DEFAULT FALSE,
    alerted_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ
);
```

---

## Local Development & Running

### 1. Environment Variables (`.env`)
```env
PORT=3000
HOST=0.0.0.0
NODE_ENV=development
DATABASE_URL=postgres://postgres:postgres@localhost:5432/zatca_bridge
SALLA_WEBHOOK_SECRET=dev_salla_webhook_secret
VAULT_MASTER_KEY_HEX=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

### 2. Install & Start
```bash
npm install
npm run dev
```

### 3. Run Verification Suite (28 Tests Across 7 Suites)
```bash
npm test
```

### 4. Run the Permanent Verification Lever
```bash
npm run verify
```

### 5. Production Docker Compose Launch
```bash
docker compose up -d --build
```
Access the Pre-Flight Debugger at `http://localhost:3000/debugger`.
