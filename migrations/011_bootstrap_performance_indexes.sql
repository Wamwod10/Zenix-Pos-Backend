-- migrate:no-transaction
-- Read-path indexes for the workspace bootstrap and high-frequency history screens.
-- Non-destructive: no rows are modified.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sale_returns_org_store_created_idx ON sale_returns(organization_id,store_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS expenses_org_store_created_idx ON expenses(organization_id,store_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS shifts_org_store_opened_idx ON shifts(organization_id,store_id,opened_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS shift_movements_shift_created_idx ON shift_movements(shift_id,created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_invoices_org_store_created_idx ON supplier_invoices(organization_id,store_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_invoices_supplier_created_idx ON supplier_invoices(supplier_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_payments_org_store_created_idx ON supplier_payments(organization_id,store_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_payments_supplier_created_idx ON supplier_payments(supplier_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS supplier_invoice_items_invoice_idx ON supplier_invoice_items(invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS stock_transfers_org_created_idx ON stock_transfers(organization_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_counts_org_store_created_idx ON inventory_counts(organization_id,store_id,created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_payments_org_submitted_idx ON billing_payments(organization_id,submitted_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS sale_items_product_sale_idx ON sale_items(product_id,sale_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS sale_payments_sale_idx ON sale_payments(sale_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS sale_returns_sale_created_idx ON sale_returns(sale_id,created_at DESC);
