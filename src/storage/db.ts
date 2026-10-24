import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://zatca_admin:secret_zatca_password@localhost:5432/zatca_ledger',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

export async function initializeDatabaseSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      DO $$ BEGIN
        CREATE TYPE invoice_type_enum AS ENUM (
            'tax_invoice',
            'simplified_tax_invoice',
            'credit_note',
            'debit_note'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      DO $$ BEGIN
        CREATE TYPE invoice_status_enum AS ENUM (
            'draft',
            'signed',
            'submitted',
            'cleared',
            'cleared_with_warnings',
            'reported',
            'reported_with_warnings',
            'rejected',
            'fallback_303'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      DO $$ BEGIN
        CREATE TYPE csid_environment_enum AS ENUM (
            'compliance',
            'production',
            'sandbox',
            'simulation'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;

      CREATE TABLE IF NOT EXISTS egs_units (
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

      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS salla_branch_id VARCHAR(64);
      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(64);
      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS csid_secret TEXT;
      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS renewal_status VARCHAR(32) NOT NULL DEFAULT 'active';
      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS last_renewal_alert_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_egs_units_merchant ON egs_units(merchant_id);
      CREATE INDEX IF NOT EXISTS idx_egs_units_merchant_salla_branch ON egs_units(merchant_id, salla_branch_id);
      CREATE INDEX IF NOT EXISTS idx_egs_units_expiry ON egs_units(expires_at, renewal_status);

      CREATE TABLE IF NOT EXISTS invoices (
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
          warning_messages JSONB,
          subtotal NUMERIC(15, 2) NOT NULL,
          tax_total NUMERIC(15, 2) NOT NULL,
          grand_total NUMERIC(15, 2) NOT NULL,
          currency CHAR(3) NOT NULL DEFAULT 'SAR',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_egs_icv UNIQUE (egs_unit_id, icv),
          CONSTRAINT uq_egs_invoice_hash UNIQUE (egs_unit_id, invoice_hash)
      );

      CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_invoices_egs_created ON invoices(egs_unit_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS zatca_submissions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          http_status_code INTEGER NOT NULL,
          response_content_type VARCHAR(128) NOT NULL,
          raw_response TEXT,
          parsed_response JSONB,
          warning_messages JSONB,
          error_messages JSONB,
          is_outage_error BOOLEAN NOT NULL DEFAULT FALSE,
          submission_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_zatca_submissions_invoice ON zatca_submissions(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_zatca_submissions_outage ON zatca_submissions(is_outage_error, submission_timestamp);

      CREATE TABLE IF NOT EXISTS zatca_dlq (
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
          next_retry_at TIMESTAMPTZ,
          alerted_at TIMESTAMPTZ,
          resolved_at TIMESTAMPTZ
      );

      ALTER TABLE zatca_dlq ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_dlq_stalled ON zatca_dlq(is_stalled, last_failed_at);
      CREATE INDEX IF NOT EXISTS idx_dlq_merchant ON zatca_dlq(merchant_id, resolved_at);
      CREATE INDEX IF NOT EXISTS idx_dlq_next_retry ON zatca_dlq(resolved_at, next_retry_at);

      CREATE TABLE IF NOT EXISTS merchant_tokens (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          merchant_id VARCHAR(64) NOT NULL UNIQUE,
          access_token_encrypted TEXT NOT NULL,
          refresh_token_encrypted TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          token_scope TEXT,
          store_name VARCHAR(255),
          vat_number VARCHAR(15),
          crn VARCHAR(32),
          city VARCHAR(100),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT chk_merchant_access_token CHECK (access_token_encrypted LIKE 'v1:%'),
          CONSTRAINT chk_merchant_refresh_token CHECK (refresh_token_encrypted LIKE 'v1:%')
      );

      ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS store_name VARCHAR(255);
      ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS vat_number VARCHAR(15);
      ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS crn VARCHAR(32);
      ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS city VARCHAR(100);

      CREATE INDEX IF NOT EXISTS idx_merchant_tokens_merchant ON merchant_tokens(merchant_id);

      CREATE TABLE IF NOT EXISTS merchant_subscriptions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          merchant_id VARCHAR(64) NOT NULL UNIQUE,
          plan_name VARCHAR(64) NOT NULL DEFAULT 'standard',
          status VARCHAR(32) NOT NULL DEFAULT 'active',
          expires_at TIMESTAMPTZ,
          trial_ends_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_subscriptions_merchant ON merchant_subscriptions(merchant_id, status);

      CREATE TABLE IF NOT EXISTS pending_b2b_orders (
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

      CREATE INDEX IF NOT EXISTS idx_pending_b2b_order ON pending_b2b_orders(order_id);
      CREATE INDEX IF NOT EXISTS idx_pending_b2b_merchant ON pending_b2b_orders(merchant_id, status);
    `);
  } finally {
    client.release();
  }
}
