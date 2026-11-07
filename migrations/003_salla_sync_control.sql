-- Migration 003: Salla Sync Control & Safe Recovery Engine
-- Introduces order synchronization state tracking, immutable transition ledger,
-- reconciliation jobs, discrepancy tracking, and refund tracking for Salla integration.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS salla_refund_id VARCHAR(128);
CREATE INDEX IF NOT EXISTS idx_invoices_refund ON invoices(salla_refund_id);

CREATE TABLE IF NOT EXISTS order_sync_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id VARCHAR(64) NOT NULL,
    order_id VARCHAR(128) NOT NULL,
    internal_order_id VARCHAR(128),
    salla_refund_id VARCHAR(128),
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
CREATE INDEX IF NOT EXISTS idx_order_sync_internal ON order_sync_records(merchant_id, internal_order_id);
CREATE INDEX IF NOT EXISTS idx_order_sync_refund ON order_sync_records(merchant_id, salla_refund_id);
CREATE INDEX IF NOT EXISTS idx_order_sync_created ON order_sync_records(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_sync_cursor ON order_sync_records(merchant_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_order_sync_records_invoice ON order_sync_records(invoice_id);

CREATE TABLE IF NOT EXISTS order_sync_transitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sync_record_id UUID NOT NULL REFERENCES order_sync_records(id) ON DELETE CASCADE,
    merchant_id VARCHAR(64) NOT NULL,
    order_id VARCHAR(128) NOT NULL,
    internal_order_id VARCHAR(128),
    salla_refund_id VARCHAR(128),
    from_state VARCHAR(50),
    to_state VARCHAR(50) NOT NULL,
    source_event VARCHAR(100),
    invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
    invoice_uuid UUID,
    correlation_id VARCHAR(128),
    attempt_number INT NOT NULL DEFAULT 1,
    recovery_permitted BOOLEAN DEFAULT FALSE,
    reason TEXT,
    error_code VARCHAR(64),
    error_category VARCHAR(64),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_transitions_rec ON order_sync_transitions(sync_record_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_sync_transitions_order ON order_sync_transitions(merchant_id, order_id);
CREATE INDEX IF NOT EXISTS idx_order_sync_transitions_invoice ON order_sync_transitions(invoice_id);

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
