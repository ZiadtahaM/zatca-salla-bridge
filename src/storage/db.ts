import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://zatca_admin:secret_zatca_password@127.0.0.1:5432/zatca_ledger',
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
          last_document_hash VARCHAR(128) NOT NULL,
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
      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS crn VARCHAR(32);
      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS vat_number VARCHAR(15);
      ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255);
      ALTER TABLE egs_units ALTER COLUMN last_document_hash TYPE VARCHAR(128);

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
          pih VARCHAR(128) NOT NULL,
          invoice_hash VARCHAR(128) NOT NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_order_original 
      ON invoices(egs_unit_id, order_id) 
      WHERE invoice_type IN ('tax_invoice', 'simplified_tax_invoice');
      ALTER TABLE invoices ALTER COLUMN pih TYPE VARCHAR(128);
      ALTER TABLE invoices ALTER COLUMN invoice_hash TYPE VARCHAR(128);

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
      ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS cod_fulfillment_statuses JSONB DEFAULT '["completed", "delivered"]'::jsonb;

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

      CREATE TABLE IF NOT EXISTS audit_logs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          entity_type VARCHAR(64) NOT NULL,
          entity_id VARCHAR(128) NOT NULL,
          action VARCHAR(32) NOT NULL,
          actor VARCHAR(128) NOT NULL,
          payload JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

      CREATE TABLE IF NOT EXISTS webhook_queue (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          merchant_id VARCHAR(100) NOT NULL,
          event_name VARCHAR(100) NOT NULL,
          idempotency_key VARCHAR(255) NOT NULL UNIQUE,
          payload JSONB NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          attempts INT NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          processed_at TIMESTAMPTZ
      );
      ALTER TABLE webhook_queue ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_webhook_queue_pending ON webhook_queue (status, created_at);

      CREATE TABLE IF NOT EXISTS order_sync_records (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          merchant_id VARCHAR(64) NOT NULL,
          order_id VARCHAR(128) NOT NULL,
          sync_state VARCHAR(50) NOT NULL,
          source_event VARCHAR(100),
          invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
          invoice_uuid UUID,
          invoice_type VARCHAR(50),
          attempt_count INT NOT NULL DEFAULT 1,
          correlation_id VARCHAR(128),
          error_code VARCHAR(64),
          error_category VARCHAR(64),
          reason TEXT,
          is_recoverable BOOLEAN NOT NULL DEFAULT FALSE,
          order_amount NUMERIC(15, 2),
          order_currency VARCHAR(10) DEFAULT 'SAR',
          customer_summary JSONB,
          eligibility_details JSONB,
          last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          next_action TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uq_merchant_order_sync UNIQUE (merchant_id, order_id)
      );

      CREATE INDEX IF NOT EXISTS idx_order_sync_merchant ON order_sync_records(merchant_id, sync_state);
      CREATE INDEX IF NOT EXISTS idx_order_sync_order ON order_sync_records(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_sync_created ON order_sync_records(merchant_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS order_sync_transitions (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          sync_record_id UUID NOT NULL REFERENCES order_sync_records(id) ON DELETE CASCADE,
          merchant_id VARCHAR(64) NOT NULL,
          order_id VARCHAR(128) NOT NULL,
          from_state VARCHAR(50),
          to_state VARCHAR(50) NOT NULL,
          source_event VARCHAR(100),
          invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
          invoice_uuid UUID,
          correlation_id VARCHAR(128),
          attempt_number INT NOT NULL DEFAULT 1,
          reason TEXT,
          error_code VARCHAR(64),
          error_category VARCHAR(64),
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sync_transitions_rec ON order_sync_transitions(sync_record_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_sync_transitions_order ON order_sync_transitions(merchant_id, order_id);

      CREATE TABLE IF NOT EXISTS salla_reconciliation_jobs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          merchant_id VARCHAR(64) NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'running',
          from_date TIMESTAMPTZ,
          to_date TIMESTAMPTZ,
          last_cursor VARCHAR(128),
          current_page INT NOT NULL DEFAULT 1,
          total_orders_scanned INT NOT NULL DEFAULT 0,
          discrepancies_found INT NOT NULL DEFAULT 0,
          orders_recovered INT NOT NULL DEFAULT 0,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_reconciliation_jobs_merchant ON salla_reconciliation_jobs(merchant_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS salla_reconciliation_discrepancies (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          job_id UUID NOT NULL REFERENCES salla_reconciliation_jobs(id) ON DELETE CASCADE,
          merchant_id VARCHAR(64) NOT NULL,
          order_id VARCHAR(128) NOT NULL,
          discrepancy_type VARCHAR(64) NOT NULL,
          details JSONB NOT NULL,
          resolved_at TIMESTAMPTZ,
          resolution_action TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_job ON salla_reconciliation_discrepancies(job_id);
      CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_order ON salla_reconciliation_discrepancies(merchant_id, order_id);

      -- Mandatory FK Indexes (System Design Law 6: INDEX_EVERY_FOREIGN_KEY)
      CREATE INDEX IF NOT EXISTS idx_invoices_replaces ON invoices(replaces_invoice_id);
      CREATE INDEX IF NOT EXISTS idx_order_sync_records_invoice ON order_sync_records(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_order_sync_transitions_invoice ON order_sync_transitions(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_dlq_egs ON zatca_dlq(egs_unit_id);
      CREATE INDEX IF NOT EXISTS idx_order_sync_cursor ON order_sync_records(merchant_id, updated_at DESC, id DESC);

      -- Tier 1 Architecture Check Constraints
      DO $$ BEGIN
          ALTER TABLE order_sync_records ADD CONSTRAINT chk_order_sync_state
          CHECK (sync_state IN (
              'not_received', 'received', 'persisted', 'awaiting_processing',
              'processing', 'successfully_processed', 'zatca_submission_pending',
              'successfully_reported', 'successfully_cleared', 'temporarily_failed',
              'permanently_failed', 'not_eligible', 'requires_human_review'
          ));
      EXCEPTION
          WHEN duplicate_object THEN null;
      END $$;

      DO $$ BEGIN
          ALTER TABLE order_sync_transitions ADD CONSTRAINT chk_sync_trans_to_state
          CHECK (to_state IN (
              'not_received', 'received', 'persisted', 'awaiting_processing',
              'processing', 'successfully_processed', 'zatca_submission_pending',
              'successfully_reported', 'successfully_cleared', 'temporarily_failed',
              'permanently_failed', 'not_eligible', 'requires_human_review'
          ));
      EXCEPTION
          WHEN duplicate_object THEN null;
      END $$;

      CREATE OR REPLACE FUNCTION prevent_audit_log_tampering()
      RETURNS TRIGGER AS $$
      BEGIN
          RAISE EXCEPTION 'TAMPER_EVIDENT_PROTECTION: UPDATE and DELETE operations are forbidden on audit_logs';
      END;
      $$ LANGUAGE plpgsql;

      DO $$ BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_logs_immutable'
          ) THEN
              CREATE TRIGGER trg_audit_logs_immutable
              BEFORE UPDATE OR DELETE ON audit_logs
              FOR EACH ROW
              EXECUTE FUNCTION prevent_audit_log_tampering();
          END IF;
      EXCEPTION
          WHEN duplicate_object THEN null;
      END $$;

      CREATE OR REPLACE FUNCTION prevent_sync_transitions_tampering()
      RETURNS TRIGGER AS $$
      BEGIN
          RAISE EXCEPTION 'TAMPER_EVIDENT_PROTECTION: UPDATE and DELETE operations are strictly forbidden on order_sync_transitions';
      END;
      $$ LANGUAGE plpgsql;

      DO $$ BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_transitions_immutable'
          ) THEN
              CREATE TRIGGER trg_sync_transitions_immutable
              BEFORE UPDATE OR DELETE ON order_sync_transitions
              FOR EACH ROW
              EXECUTE FUNCTION prevent_sync_transitions_tampering();
          END IF;
      EXCEPTION
          WHEN duplicate_object THEN null;
      END $$;

      CREATE OR REPLACE FUNCTION prevent_invoice_tampering()
      RETURNS TRIGGER AS $$
      BEGIN
          IF (TG_OP = 'DELETE') THEN
              RAISE EXCEPTION 'TAMPER_EVIDENT_PROTECTION: DELETE operations are strictly forbidden on invoices';
          END IF;
          IF (TG_OP = 'UPDATE') THEN
              IF (OLD.uuid IS DISTINCT FROM NEW.uuid OR
                  OLD.icv IS DISTINCT FROM NEW.icv OR
                  OLD.pih IS DISTINCT FROM NEW.pih OR
                  OLD.invoice_hash IS DISTINCT FROM NEW.invoice_hash OR
                  OLD.signed_xml IS DISTINCT FROM NEW.signed_xml OR
                  OLD.subtotal IS DISTINCT FROM NEW.subtotal OR
                  OLD.tax_total IS DISTINCT FROM NEW.tax_total OR
                  OLD.grand_total IS DISTINCT FROM NEW.grand_total) THEN
                  RAISE EXCEPTION 'TAMPER_EVIDENT_PROTECTION: Core financial and cryptographic invoice fields are immutable';
              END IF;
          END IF;
          RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DO $$ BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM pg_trigger WHERE tgname = 'trg_invoices_immutable'
          ) THEN
              CREATE TRIGGER trg_invoices_immutable
              BEFORE UPDATE OR DELETE ON invoices
              FOR EACH ROW
              EXECUTE FUNCTION prevent_invoice_tampering();
          END IF;
      EXCEPTION
          WHEN duplicate_object THEN null;
      END $$;
    `);
  } finally {
    client.release();
  }
}

export async function recordAuditLog(
  client: any,
  entry: {
    entityType: string;
    entityId: string;
    action: string;
    actor: string;
    payload?: any;
  }
): Promise<string> {
  const res = await client.query(
    `INSERT INTO audit_logs (entity_type, entity_id, action, actor, payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [entry.entityType, entry.entityId, entry.action, entry.actor, entry.payload ? JSON.stringify(entry.payload) : null]
  );
  return res.rows[0].id;
}
