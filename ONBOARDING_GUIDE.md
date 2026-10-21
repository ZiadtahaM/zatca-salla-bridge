# Merchant Onboarding & Operational Data Guide

Complete operational guide for onboarding Saudi merchants from the ZATCA Fatoora Portal and Salla Partners to `zatca-salla-bridge`.

---

## 1. Onboarding Flow

```
Step 1: Merchant Fatoora Portal
  - Log in to fatoora.zatca.gov.sa
  - Click "Onboarding Solution Devices" -> "Generate OTP"
  - Copy 6-digit OTP (e.g. 123456, valid for 60 mins)
          │
          ▼
Step 2: API Onboarding Call
  - Call POST /api/egs/onboard with merchantId, branchId, storeName, vatNumber, otp
  - Server generates secp256k1 key + CSR with ZATCA OIDs
  - Server exchanges OTP with ZATCA for Compliance CSID (CCSID)
  - Server completes 3 compliance checks (Standard, Simplified, Credit Note)
  - Server receives Production CSID (PCSID)
  - Server encrypts private key & CSID secret (AES-256-GCM v1:) and saves to egs_units
          │
          ▼
Step 3: Salla Partner App Store Install
  - Merchant clicks "Install App" on Salla
  - Salla fires POST /webhooks/salla/authorize
  - Server encrypts OAuth access_token and refresh_token into merchant_tokens
          │
          ▼
Step 4: Live Store Operation
  - Live orders stream to POST /webhooks/salla
  - Webhooks signed, cleared, or queued automatically
```

---

## 2. Step 1: Generating the ZATCA Fatoora Portal OTP

1. The store accountant or business owner navigates to:
   - **Simulation Portal:** `https://fatoora.zatca.gov.sa/`
   - **Production Portal:** `https://fatoora.zatca.gov.sa/`
2. Authenticate using their Saudi National Single Sign-On (Nafath) or ZATCA portal credentials.
3. In the sidebar, select **Onboard New Solution Unit / Device**.
4. Enter unit identifier (e.g., `POS-01` or `SALLA-MAIN`).
5. Click **Generate OTP**.
6. A 6-digit numeric code is displayed (e.g. `489215`). This code expires after 60 minutes.

---

## 3. Step 2: Executing Onboarding via API

Send the following HTTP request to your deployed bridge instance:

```bash
curl -X POST https://<YOUR_DOMAIN>/api/egs/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "merchantId": "salla_store_99481",
    "branchId": "branch_olaya_01",
    "storeName": "شركة رواء للملابس الفاخرة",
    "vatNumber": "300075588700003",
    "otp": "489215",
    "isProduction": false
  }'
```

### JSON Request Schema (`OnboardRequestSchema`)

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `merchantId` | string | Yes | Min 1 char | Salla Merchant ID (e.g. `salla_store_99481`) |
| `branchId` | string | Yes | Min 1 char | Branch or location identifier (e.g. `main_branch`) |
| `storeName` | string | Yes | Min 1 char | Arabic legal business name (e.g. `شركة رواء للملابس`) |
| `vatNumber` | string | Yes | Exact 15 digits (`^3\d{13}3$`) | Saudi VAT registration number |
| `otp` | string | Yes | Exact 6 digits | The 60-minute OTP generated from the Fatoora portal |
| `isProduction` | boolean | No | Default `false` | Set `true` when connecting to live ZATCA production |

### Response Schema (`200 OK`)

```json
{
  "status": "onboarded",
  "egs_unit_id": "e739ba62-45ba-4f42-b48c-727302355928",
  "customId": "POS-branch_olaya_01-01",
  "environment": "compliance",
  "expires_at": "2027-10-21T14:00:00.000Z"
}
```

---

## 4. Step 3: Salla App Store Webhook Setup

### Path A: Salla App Store (Automated OAuth2)
When publishing as a Salla Partner App:
1. Set the webhook URL in Salla Developer Portal:
   - Event: `app.store.authorize`
   - Target URL: `https://<YOUR_DOMAIN>/webhooks/salla/authorize`
2. Set the order webhooks:
   - Target URL: `https://<YOUR_DOMAIN>/webhooks/salla`
   - Events subscribed:
     - `order.created`
     - `order.updated`
     - `order.refunded`
     - `order.cancelled`
3. Copy the webhook secret into your `.env` file as `SALLA_WEBHOOK_SECRET`.

### Path B: Private Store Direct Webhook
For custom agency clients without App Store publishing:
1. In Salla Admin: **Settings** -> **Webhooks** -> **Add New Webhook**.
2. Webhook URL: `https://<YOUR_DOMAIN>/webhooks/salla`.
3. Secret: Enter the secret defined in your server's `SALLA_WEBHOOK_SECRET`.
4. Trigger Events: Check `order.created`, `order.updated`, `order.refunded`, `order.cancelled`.

---

## 5. Database Verification Queries

Inspect the live PostgreSQL database to confirm onboarding and security compliance:

```sql
-- 1. Check EGS unit registration and check constraints
SELECT id, merchant_id, branch_id, custom_id, csid_environment, 
       LEFT(private_key_pem, 15) AS key_vault, 
       LEFT(csid_secret, 15) AS secret_vault,
       current_icv, expires_at, is_active
FROM egs_units;

-- Notice: private_key_pem and csid_secret must both start with 'v1:' (AES-256-GCM ciphertext).
-- Plaintext PEM or tokens are blocked by PostgreSQL check constraints.

-- 2. Check Salla OAuth token storage
SELECT merchant_id, LEFT(access_token_encrypted, 15) AS token_vault, expires_at, token_scope
FROM merchant_tokens;

-- 3. Check processed invoices and credit notes
SELECT id, order_id, invoice_type, icv, pih, invoice_hash, 
       status, subtotal, tax_total, grand_total, created_at
FROM invoices
ORDER BY created_at DESC
LIMIT 10;

-- 4. Check B2B orders currently in the enrichment hold queue
SELECT id, order_id, buyer_vat, buyer_name, missing_fields, status, created_at
FROM pending_b2b_orders
WHERE status = 'pending_enrichment';

-- 5. Check Dead Letter Queue (DLQ) for stalled invoices
SELECT id, invoice_id, merchant_id, failure_reason, attempt_count, is_stalled, last_failed_at
FROM zatca_dlq
WHERE resolved_at IS NULL;
```

---

## 6. Common Onboarding Error Codes & Resolutions

| Error Message / Code | Root Cause | Deterministic Resolution |
| --- | --- | --- |
| `OTP is invalid or expired` | The 6-digit OTP entered has expired (past 60 minutes) or was already used. | Generate a fresh OTP from the Fatoora Portal and retry immediately. |
| `Saudi VAT number must be 15 digits starting and ending with 3` | Validation failed on `vatNumber`. | Verify the 15-digit number starts with `3` and ends with `3` (`^3\d{13}3$`). |
| `error:068000A8:asn1 encoding routines::wrong tag` | `binarySecurityToken` from Fatoora lacked 64-character PEM line wrapping. | The onboarding service automatically applies 64-character line wrapping (`wrappedCertBase64`). |
| `NO_ACTIVE_EGS_UNIT` on webhook | Salla order received for a merchant that has not completed Step 2. | Call `POST /api/egs/onboard` with merchantId matching the Salla store ID. |
| `chk_egs_encrypted_key` check constraint | An unencrypted key attempted insertion into PostgreSQL. | The vault service enforces AES-256-GCM encryption with `v1:` envelope before writing to DB. |
