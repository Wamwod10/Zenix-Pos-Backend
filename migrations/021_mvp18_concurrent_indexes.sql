-- migrate:no-transaction
-- Keep index builds outside a transaction so existing payment writes continue.
CREATE INDEX CONCURRENTLY IF NOT EXISTS extra_store_entitlements_active_idx
  ON extra_store_entitlements(organization_id, starts_on, expires_on);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS billing_payments_org_id_unique
  ON billing_payments(organization_id, id);
