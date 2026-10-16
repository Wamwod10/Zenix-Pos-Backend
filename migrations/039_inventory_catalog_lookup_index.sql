-- migrate:no-transaction
-- Review required before production. Measured owner catalog stock lookup scans
-- 100k balances once per visible product without org/product leading keys.
-- CONCURRENTLY preserves writes. Failure may leave an invalid index: inspect
-- pg_index.indisvalid, DROP INDEX CONCURRENTLY if invalid, then retry explicitly.
-- Rollback command: DROP INDEX CONCURRENTLY inventory_balances_org_product_store_idx
SET lock_timeout='5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_balances_org_product_store_idx
 ON inventory_balances(organization_id,product_id,store_id);
RESET lock_timeout;
