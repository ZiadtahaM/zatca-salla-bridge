# Production Deployment & Merchant Onboarding Runbook

This guide covers real-world production deployment, Salla App Store configuration, and ZATCA Phase 2 onboarding for live merchants.

---

## 1. Production Secrets Generation

Before deploying, generate cryptographically secure keys:

```bash
# 1. 256-bit AES Vault Key for private keys & CSID secrets
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Session Secret for HMAC auth cookies
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Configure these in your production environment or Docker `.env`:

```env
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgres://zatca_user:strong_password@db-host:5432/zatca_ledger?sslmode=require
DATABASE_SSL=true
VAULT_KEY_HEX=<generated-64-character-hex>
SESSION_SECRET=<generated-64-character-hex>
SALLA_WEBHOOK_SECRET=<secret-configured-in-salla-partners-portal>
ZATCA_ENV=production
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
```

---

## 2. Salla Partners Portal Configuration

1. Log into [Salla Partners Portal](https://partners.salla.com).
2. Create or open your App.
3. In **App Details**, configure:
   - **Scopes**: `offline_access`, `orders.read`, `orders.write`, `products.read`.
   - **Callback URL**: `https://<your-domain>/api/salla/oauth/callback`.
4. In **Webhooks**, set:
   - **Webhook URL**: `https://<your-domain>/webhooks/salla`.
   - **Secret**: Copy into `SALLA_WEBHOOK_SECRET`.
   - **Events**:
     - `order.created`
     - `order.updated`
     - `order.refunded`
     - `shipment.created`
     - `shipment.updated`
     - `app.store.authorize`

---

## 3. ZATCA FATOORA Live Onboarding Workflow

1. The merchant logs into the ZATCA ERAD/FATOORA Portal using their official tax credentials.
2. Under **Fatoora Onboarding**, generate a **6-digit One-Time Password (OTP)**. The OTP is valid for 60 minutes.
3. Submit the onboarding payload via the merchant portal UI or API:

```bash
curl -X POST https://<your-domain>/api/egs/onboard \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session-token>" \
  -d '{
    "merchantId": "merchant_12345",
    "branchId": "riyadh_main",
    "vatNumber": "300075588700003",
    "crn": "1010010000",
    "storeName": "متجر الأمل التجاري",
    "otp": "123456",
    "environment": "production",
    "invoiceType": "1100"
  }'
```

4. The bridge automatically:
   - Generates an ECDSA `secp256k1` private key and CSR with ZATCA OIDs.
   - Calls `POST /compliance` to request a Compliance CSID.
   - Executes the 6 mandatory compliance checks (Standard & Simplified 388, 381, 383).
   - Calls `POST /production/csids` to receive the live Production CSID.
   - Encrypts the private key and CSID secret with AES-256-GCM into `egs_units`.

---

## 4. Verification & Operational Probes

- **Liveness Check**: `GET /health` returns HTTP 200 `{ status: "healthy" }`.
- **Readiness Check**: `GET /ready` verifies live PostgreSQL connectivity `{ status: "ready", database: "connected" }`.
- **Merchant Portal**: `GET /portal?merchantId=<id>&token=<token>` displays the live dashboard, status indicators, and reconciliation export.
- **Auditing**: `GET /api/invoices/export.csv?merchantId=<id>` generates accountant-ready UTF-8 BOM CSV for ZATCA VAT Return Box 1 reconciliation.
