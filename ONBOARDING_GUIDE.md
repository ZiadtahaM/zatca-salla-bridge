# Merchant Onboarding and Operational Data Architecture Guide

Complete operational guide for onboarding Saudi merchants from Salla Partners and the ZATCA Fatoora Portal to zatca-salla-bridge.

## 1. Operational Flow

The integration operates without manual curl commands or technical intervention.

```
Step 1: Salla App Store Installation
  - Merchant installs the app from Salla App Store.
  - Salla sends app.store.authorize webhook to POST /webhooks/salla/authorize.
  - Server exchanges code, stores AES-256-GCM encrypted tokens in merchant_tokens.
  - Server automatically queries GET https://api.salla.dev/admin/v2/store/info.
  - Arabic store name, 15-digit VAT number, CRN, and city are saved to the profile.
          │
          ▼
Step 2: Merchant Self-Service Portal (GET /portal?merchantId=...)
  - Merchant opens the web portal (or clicks open from Salla Admin).
  - Store details are already pre-filled.
  - Merchant logs into fatoora.zatca.gov.sa and generates a 6-digit OTP.
  - Merchant selects environment (Simulation or Production), pastes OTP, and clicks "ربط مع فاتورة".
  - Portal calls POST /api/egs/onboard.
  - Server generates secp256k1 key and CSR with ZATCA OIDs.
  - Server completes compliance verification (6 documents for 1100 standard and simplified).
  - Server obtains Production CSID, encrypts secrets with AES-256-GCM, and activates the EGS unit.
          │
          ▼
Step 3: Autonomous Webhook Ingestion & Outbound Dispatch
  - Live orders stream to POST /webhooks/salla.
  - Webhooks check subscription status (merchant_subscriptions). Inactive subscriptions receive HTTP 402.
  - COD and Bank Transfer orders hold signing until status becomes completed or delivered.
  - Incomplete B2B buyer addresses route to pending_b2b_orders hold queue.
  - Valid orders undergo row-locked ICV allocation, single-pass XAdES-BES signing, and TLV QR generation.
  - Outbound dispatcher sends standard invoices to ZATCA clearance and simplified invoices to reporting.
  - Dispatcher retries network outages through the Dead Letter Queue (zatca_dlq).
  - Dispatcher posts confirmation notes to Salla order history timelines.
          │
          ▼
Step 4: Held B2B Orders and Invoices Self-Service
  - If a corporate buyer omits a 4-digit building number or 5-digit postal code, order appears in Tab 2.
  - Accountant inputs missing address fields in the portal and clicks "تحديث وإصدار الفاتورة".
  - Invoice is signed and submitted immediately without developer assistance.
  - Merchants and buyers download PDF/A-3 invoices or print bilingual tax invoices directly from Tab 3.
```

## 2. Generating the ZATCA Fatoora Portal OTP

1. The store owner or accountant navigates to:
   - Simulation Portal: `https://fatoora.zatca.gov.sa/`
   - Production Portal: `https://fatoora.zatca.gov.sa/`
2. Authenticate using Saudi National Single Sign-On (Nafath) or ZATCA portal credentials.
3. In the sidebar, select Onboard New Solution Unit / Device.
4. Enter unit identifier (example: `POS-01` or `SALLA-MAIN`).
5. Click Generate OTP.
6. A 6-digit numeric code is displayed (example: `489215`). This code expires after 60 minutes.

## 3. Web Portal Onboarding (Zero Developer Intervention)

Merchants do not run terminal commands. They use the built-in bilingual web portal:

1. Open `https://<YOUR_DOMAIN>/portal?merchantId=<SALLA_MERCHANT_ID>`.
2. Tab 1 displays the store name and VAT registration number pre-filled from Salla OAuth.
3. Select the target environment:
   - Simulation (recommended for testing first live webhook orders).
   - Production (for official statutory compliance).
4. Enter the 6-digit OTP from the Fatoora Portal.
5. Click "ربط مع فاتورة (Connect ZATCA)".
6. The portal submits an asynchronous request to `POST /api/egs/onboard`.
7. Once confirmed, the unit status badge turns green with active CSID expiration and ICV counter.

## 4. API Specification for Automated Onboarding

External integrations and test runners invoke the onboarding endpoint directly:

```bash
curl -X POST https://<YOUR_DOMAIN>/api/egs/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "merchantId": "salla_store_99481",
    "branchId": "branch_olaya_01",
    "storeName": "شركة رواء للملابس الفاخرة",
    "vatNumber": "300075588700003",
    "otp": "489215",
    "environment": "simulation"
  }'
```

### JSON Request Schema (`OnboardRequestSchema`)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `merchantId` | string | Yes | Min 1 char | Salla Merchant ID (example: `salla_store_99481`) |
| `branchId` | string | Yes | Min 1 char | Branch or location identifier (example: `main_branch`) |
| `storeName` | string | Yes | Min 1 char | Arabic legal business name |
| `vatNumber` | string | Yes | Exact 15 digits (`^3\d{13}3$`) | Saudi VAT registration number |
| `otp` | string | Yes | Exact 6 digits | The 60-minute OTP generated from the Fatoora portal |
| `environment` | string | No | `sandbox`, `simulation`, `production` | Target ZATCA environment (default: `production`) |
| `isProduction` | boolean | No | Legacy flag | Backwards compatible environment toggle |

### Response Schema (`200 OK`)

```json
{
  "status": "onboarded",
  "egs_unit_id": "e739ba62-45ba-4f42-b48c-727302355928",
  "customId": "POS-branch_olaya_01-01",
  "environment": "simulation",
  "expires_at": "2027-10-21T14:00:00.000Z"
}
```

## 5. Non-Destructive CSID Renewal

Production CSIDs expire after 12 months. Merchants renew certificates via Tab 4 of the portal or via API without resetting the monotonic ICV counter or breaking the cryptographic hash chain:

```bash
curl -X POST https://<YOUR_DOMAIN>/api/egs/e739ba62-45ba-4f42-b48c-727302355928/renew \
  -H "Content-Type: application/json" \
  -d '{
    "otp": "781204"
  }'
```

The renewal routine issues `PATCH /production/csids` to ZATCA, stores the new encrypted certificate and secret in `egs_units`, and preserves existing `current_icv` and `last_document_hash`.

## 6. Database Architecture and Data Dictionary

The persistence layer runs on PostgreSQL with strict check constraints and foreign key relationships.

### `egs_units` (Cryptographic Stamps and Sequence Ledger)

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | UUID | PRIMARY KEY | Unique internal EGS device ID |
| `merchant_id` | VARCHAR(64) | NOT NULL | Foreign key reference to merchant |
| `branch_id` | VARCHAR(64) | NOT NULL | Branch identifier |
| `salla_branch_id` | VARCHAR(64) | NULLABLE | Mapped Salla branch identifier |
| `terminal_id` | VARCHAR(64) | NULLABLE | Retail POS terminal identifier |
| `custom_id` | VARCHAR(100) | NOT NULL | Human-readable device code (`POS-<branch>-<seq>`) |
| `csid_environment` | ENUM | NOT NULL | `compliance`, `production`, `sandbox`, `simulation` |
| `certificate` | TEXT | NOT NULL | X.509 PEM certificate issued by ZATCA |
| `private_key_pem` | TEXT | CHECK (`LIKE 'v1:%'`) | AES-256-GCM encrypted secp256k1 private key |
| `csid_secret` | TEXT | CHECK (`LIKE 'v1:%'`) | AES-256-GCM encrypted API basic auth secret |
| `current_icv` | BIGINT | NOT NULL, DEFAULT 0 | Strict monotonic invoice counter |
| `last_document_hash` | VARCHAR(64) | NOT NULL | Previous invoice hash (PIH) for chaining |
| `expires_at` | TIMESTAMPTZ | NOT NULL | CSID certificate expiration timestamp |
| `renewal_status` | VARCHAR(32) | NOT NULL | `active`, `expiring_soon`, `expired`, `renewed` |
| `is_active` | BOOLEAN | NOT NULL, DEFAULT TRUE | Device active status |

### `invoices` (Audit-Proof E-Invoice Ledger)

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | UUID | PRIMARY KEY | Internal invoice identifier |
| `egs_unit_id` | UUID | REFERENCES `egs_units` | Signing EGS device |
| `order_id` | VARCHAR(128) | NOT NULL | Salla order identifier |
| `idempotency_key` | VARCHAR(128) | UNIQUE | Salla webhook deduplication key |
| `invoice_type` | ENUM | NOT NULL | `tax_invoice`, `simplified_tax_invoice`, `credit_note`, `debit_note` |
| `uuid` | UUID | UNIQUE | RFC 4122 invoice UUID |
| `icv` | BIGINT | NOT NULL | Invoice counter value assigned to this document |
| `pih` | VARCHAR(64) | NOT NULL | Previous document hash |
| `invoice_hash` | VARCHAR(64) | NOT NULL | SHA-256 hash of canonicalized XML |
| `qr_code_payload` | TEXT | NOT NULL | Base64-encoded TLV QR code string |
| `signed_xml` | TEXT | NOT NULL | UBL 2.1 XML with embedded XAdES-BES signature |
| `cleared_xml` | TEXT | NULLABLE | ZATCA cleared XML returned for standard B2B invoices |
| `status` | ENUM | NOT NULL | `draft`, `signed`, `submitted`, `cleared`, `reported`, `rejected` |
| `subtotal` | NUMERIC(15,2) | NOT NULL | Total excluding VAT |
| `tax_total` | NUMERIC(15,2) | NOT NULL | 15% VAT amount |
| `grand_total` | NUMERIC(15,2) | NOT NULL | Final invoice total |

### `pending_b2b_orders` (National Address Hold Queue)

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | UUID | PRIMARY KEY | Queue record identifier |
| `merchant_id` | VARCHAR(64) | NOT NULL | Store identifier |
| `order_id` | VARCHAR(128) | NOT NULL | Salla order identifier |
| `buyer_vat` | VARCHAR(15) | NOT NULL | Corporate buyer 15-digit VAT number |
| `buyer_name` | VARCHAR(255) | NOT NULL | Corporate buyer company name |
| `missing_fields` | JSONB | NOT NULL | Array of missing fields (`building_number`, `postal_code`, etc.) |
| `order_payload` | JSONB | NOT NULL | Full raw order payload held safely |
| `status` | VARCHAR(32) | NOT NULL | `pending_enrichment`, `enriched`, `cancelled` |

### `merchant_tokens` (Encrypted Salla Credentials and Profile)

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `merchant_id` | VARCHAR(64) | UNIQUE | Salla merchant identifier |
| `access_token_encrypted` | TEXT | CHECK (`LIKE 'v1:%'`) | AES-256-GCM encrypted OAuth access token |
| `refresh_token_encrypted` | TEXT | CHECK (`LIKE 'v1:%'`) | AES-256-GCM encrypted OAuth refresh token |
| `expires_at` | TIMESTAMPTZ | NOT NULL | OAuth token expiration (refreshed automatically every 14 days) |
| `store_name` | VARCHAR(255) | NULLABLE | Arabic store name from Salla Store Info API |
| `vat_number` | VARCHAR(15) | NULLABLE | Store VAT number from Salla Store Info API |
| `crn` | VARCHAR(32) | NULLABLE | Commercial registration number |
| `city` | VARCHAR(100) | NULLABLE | Store registered city |

### `merchant_subscriptions` (Salla App Store Billing Lifecycle)

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `merchant_id` | VARCHAR(64) | UNIQUE | Salla merchant identifier |
| `plan_name` | VARCHAR(64) | NOT NULL | Subscription tier (`standard`, `pro`, `enterprise`) |
| `status` | VARCHAR(32) | NOT NULL | `active`, `trialing`, `past_due`, `cancelled`, `uninstalled` |
| `expires_at` | TIMESTAMPTZ | NULLABLE | Subscription expiration timestamp |
| `trial_ends_at` | TIMESTAMPTZ | NULLABLE | Free trial expiration timestamp |

### `zatca_dlq` (Dead Letter Queue and Backpressure Monitor)

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | UUID | PRIMARY KEY | Queue entry identifier |
| `invoice_id` | UUID | REFERENCES `invoices` | Target invoice |
| `merchant_id` | VARCHAR(64) | NOT NULL | Merchant identifier |
| `failure_reason` | TEXT | NOT NULL | Gateway rejection or timeout description |
| `http_status` | INTEGER | NULLABLE | Gateway HTTP response code |
| `attempt_count` | INTEGER | NOT NULL | Number of retry attempts |
| `is_stalled` | BOOLEAN | NOT NULL | True if failed for more than 30 minutes |
| `next_retry_at` | TIMESTAMPTZ | NULLABLE | Next scheduled retry timestamp |
| `resolved_at` | TIMESTAMPTZ | NULLABLE | Resolution timestamp |

## 7. Verification Queries

Inspect the database to verify active state:

```sql
-- Check active EGS units and encryption envelope
SELECT id, merchant_id, branch_id, custom_id, csid_environment,
       LEFT(private_key_pem, 15) AS key_vault,
       LEFT(csid_secret, 15) AS secret_vault,
       current_icv, expires_at, is_active
FROM egs_units;

-- Check stored merchant profiles from Salla OAuth
SELECT merchant_id, store_name, vat_number, crn, city, expires_at
FROM merchant_tokens;

-- Check active subscriptions
SELECT merchant_id, plan_name, status, expires_at
FROM merchant_subscriptions;

-- Check invoices awaiting buyer address enrichment
SELECT order_id, buyer_name, buyer_vat, missing_fields, created_at
FROM pending_b2b_orders
WHERE status = 'pending_enrichment';

-- Check Dead Letter Queue for stalled items
SELECT id, invoice_id, merchant_id, failure_reason, attempt_count, is_stalled
FROM zatca_dlq
WHERE resolved_at IS NULL;
```
