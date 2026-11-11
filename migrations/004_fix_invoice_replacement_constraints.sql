-- Migration 004: Fix Invoice Replacement Constraints and Add Stored Order Payload
-- 1. Adds 'rejected_reporting' to invoice_status_enum if not already present.
-- 2. Drops the overly restrictive partial index on invoices(egs_unit_id, order_id)
--    which previously blocked creating corrected replacement invoices for rejected orders.
-- 3. Re-creates the unique index uq_invoices_order_original to ensure that only active,
--    non-replaced original invoices enforce uniqueness per (egs_unit_id, order_id).
-- 4. Adds order_payload JSONB column to order_sync_records and invoices to preserve
--    the authoritative raw source order data and eliminate synthetic fallbacks.

ALTER TYPE invoice_status_enum ADD VALUE IF NOT EXISTS 'rejected_reporting';

DROP INDEX IF EXISTS uq_invoices_order_original;

CREATE UNIQUE INDEX uq_invoices_order_original
ON invoices(egs_unit_id, order_id)
WHERE invoice_type IN ('tax_invoice', 'simplified_tax_invoice')
  AND status NOT IN ('rejected', 'rejected_reporting')
  AND replaces_invoice_id IS NULL;

ALTER TABLE order_sync_records ADD COLUMN IF NOT EXISTS order_payload JSONB;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS raw_order_payload JSONB;

