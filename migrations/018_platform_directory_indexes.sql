-- migrate:no-transaction
-- Read-only dashboard and bounded platform payment queues, additive only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_payments_submitted_id_paging_idx
  ON billing_payments (submitted_at DESC,id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_payments_status_submitted_idx
  ON billing_payments (status,submitted_at DESC,id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS organizations_license_created_idx
  ON organizations (license_status,created_at DESC,id DESC);
