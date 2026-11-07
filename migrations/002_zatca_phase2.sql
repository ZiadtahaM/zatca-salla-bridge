-- Migration 002: ZATCA Phase 2 Enhancements
-- Upgrades hash columns to VARCHAR(128) for SHA-256 base64, adds dynamic seller identity,
-- adds anti-tampering triggers for audit_logs and invoices, and original invoice partial unique constraints.

ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS salla_branch_id VARCHAR(64);
ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(64);
ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS csid_secret TEXT;
ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS renewal_status VARCHAR(32) NOT NULL DEFAULT 'active';
ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS last_renewal_alert_at TIMESTAMPTZ;
ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS crn VARCHAR(32);
ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS vat_number VARCHAR(15);
ALTER TABLE egs_units ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255);
ALTER TABLE egs_units ALTER COLUMN last_document_hash TYPE VARCHAR(128);

ALTER TABLE invoices ALTER COLUMN pih TYPE VARCHAR(128);
ALTER TABLE invoices ALTER COLUMN invoice_hash TYPE VARCHAR(128);

ALTER TABLE zatca_dlq ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS store_name VARCHAR(255);
ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS vat_number VARCHAR(15);
ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS crn VARCHAR(32);
ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS cod_fulfillment_statuses JSONB DEFAULT '["completed", "delivered"]'::jsonb;
ALTER TABLE merchant_tokens ADD COLUMN IF NOT EXISTS status_event_mapping JSONB;

ALTER TABLE webhook_queue ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_order_original 
ON invoices(egs_unit_id, order_id) 
WHERE invoice_type IN ('tax_invoice', 'simplified_tax_invoice');

CREATE INDEX IF NOT EXISTS idx_invoices_replaces ON invoices(replaces_invoice_id);
CREATE INDEX IF NOT EXISTS idx_dlq_egs ON zatca_dlq(egs_unit_id);

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
