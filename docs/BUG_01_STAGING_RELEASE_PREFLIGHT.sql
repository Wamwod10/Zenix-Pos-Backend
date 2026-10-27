-- ZENIX POS / BUG-01 — READ-ONLY STAGING RELEASE PREFLIGHT
-- Run only after migrations 045 and 046 have been applied to an isolated
-- staging database. This script does not modify rows, schemas or settings.
-- It is NOT approval to migrate, deploy or correct production history.
-- Example (staging only): psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/BUG_01_STAGING_RELEASE_PREFLIGHT.sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- 1. Schema readiness: expect 46 known migrations, 045/046 present,
--    snapshot protection enabled, and create replay allowed.
SELECT
  (SELECT COUNT(*) FROM schema_migrations) AS migration_count,
  (SELECT COUNT(*) FROM schema_migrations WHERE name IN (
    '045_transfer_cost_snapshot.sql', '046_transfer_create_replay.sql'
  ) AND checksum ~ '^[0-9a-f]{64}$') AS target_migrations_with_checksums,
  (SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='public' AND table_name='stock_transfer_items'
     AND column_name='unit_cost_snapshot') AS snapshot_columns,
  (SELECT COUNT(*) FROM pg_trigger
   WHERE tgname='transfer_cost_snapshot_immutable' AND tgenabled='O') AS enabled_immutability_triggers,
  (SELECT pg_get_constraintdef(oid) LIKE '%transfer_create%'
   FROM pg_constraint WHERE conname='financial_write_replays_operation_check'
   LIMIT 1) AS transfer_replay_allowed;

-- 2. Scope/stock invariants. All mismatches should be zero.
WITH warehouse_qty AS (
  SELECT organization_id,store_id,product_id,SUM(quantity) AS quantity
  FROM warehouse_balances
  GROUP BY organization_id,store_id,product_id
)
SELECT COUNT(*) AS inventory_rows,
       COUNT(*) FILTER(WHERE b.quantity IS DISTINCT FROM COALESCE(w.quantity,0)) AS partition_mismatches,
       COUNT(*) FILTER(WHERE b.quantity < 0 OR b.avg_cost < 0) AS negative_quantity_or_cost,
       SUM(b.quantity*b.avg_cost)::text AS current_inventory_valuation
FROM inventory_balances b LEFT JOIN warehouse_qty w
 USING (organization_id,store_id,product_id);

-- 3. Active/legacy transfers: this is an exception queue, not a migration
--    input or permission to backfill. NULL is unknown, 0 may be legitimate.
SELECT t.status,
       COUNT(DISTINCT t.id) AS transfer_count,
       COUNT(*) AS line_count,
       COUNT(*) FILTER(WHERE ti.unit_cost_snapshot IS NULL) AS null_cost_lines,
       COALESCE(SUM(ti.sent_quantity),0)::text AS sent_qty,
       COALESCE(SUM(ti.received_quantity),0)::text AS received_qty
FROM stock_transfers t JOIN stock_transfer_items ti ON ti.transfer_id=t.id
WHERE t.status IN ('pending','approved','dispatched')
GROUP BY t.status ORDER BY t.status;

-- 4. Financial document invariants: mismatches must be zero.
WITH item_sums AS (
  SELECT sale_id,SUM(line_total) AS total FROM sale_items GROUP BY sale_id
), refund_sums AS (
  SELECT sale_id,SUM(amount) AS total FROM sale_returns GROUP BY sale_id
)
SELECT COUNT(*) AS sale_count,
       COUNT(*) FILTER(WHERE ABS(s.total-COALESCE(i.total,0)) > 0.01)
         AS sale_document_mismatches,
       COUNT(*) FILTER(WHERE ABS(s.returned_amount-COALESCE(r.total,0)) > 0.01)
         AS refund_document_mismatches
FROM sales s LEFT JOIN item_sums i ON i.sale_id=s.id
             LEFT JOIN refund_sums r ON r.sale_id=s.id;

-- 5. Refund-cost provenance diagnostics, NOT a profit-misstatement amount.
--    A return movement with cost=0 and a nonzero original sale movement may
--    be a historical bug. Current finance API can reverse original sale COGS
--    through its fallback; reconcile impact separately with an accountant.
WITH return_costs AS (
  SELECT r.id,r.quantity,r.amount,
    original.unit_cost AS original_cost,
    ret.unit_cost AS return_movement_cost
  FROM sale_returns r
  LEFT JOIN LATERAL (
    SELECT m.unit_cost FROM stock_movements m
    WHERE m.organization_id=r.organization_id AND m.store_id=r.store_id
      AND m.product_id=r.product_id AND m.type='sale'
      AND m.reference_type='sale' AND m.reference_id=r.sale_id::text
    ORDER BY m.created_at LIMIT 1
  ) original ON TRUE
  LEFT JOIN LATERAL (
    SELECT m.unit_cost FROM stock_movements m
    WHERE m.organization_id=r.organization_id AND m.store_id=r.store_id
      AND m.product_id=r.product_id AND m.type='return'
      AND m.reference_type='return' AND m.reference_id=r.id::text
    ORDER BY m.created_at LIMIT 1
  ) ret ON TRUE
)
SELECT COUNT(*) AS returns_checked,
       COUNT(*) FILTER(WHERE original_cost IS NULL) AS missing_original_cost,
       COUNT(*) FILTER(WHERE original_cost IS DISTINCT FROM return_movement_cost)
         AS movement_cost_disagreement_rows,
       COALESCE(SUM(quantity*original_cost),0)::text AS original_cogs_reversal_evidence,
       COALESCE(SUM(quantity*return_movement_cost),0)::text AS stored_return_movement_value
FROM return_costs;

-- 6. Transfer-item tenant and return tenant integrity.
SELECT
  (SELECT COUNT(*) FROM stock_transfer_items ti
    JOIN stock_transfers t ON t.id=ti.transfer_id
    LEFT JOIN products p ON p.id=ti.product_id AND p.organization_id=t.organization_id
    WHERE p.id IS NULL) AS transfer_product_cross_tenant_or_missing,
  (SELECT COUNT(*) FROM sale_returns r LEFT JOIN sales s
    ON s.id=r.sale_id AND s.organization_id=r.organization_id AND s.store_id=r.store_id
    WHERE s.id IS NULL) AS refund_scope_mismatches;

COMMIT;
