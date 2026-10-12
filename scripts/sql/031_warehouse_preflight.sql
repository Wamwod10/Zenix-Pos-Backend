-- Every violations count must be zero. Check catalog checksums separately with Node.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SELECT 'inventory_store_orphans' AS check_name,count(*) AS violations FROM inventory_balances b LEFT JOIN stores s ON (s.organization_id,s.id)=(b.organization_id,b.store_id) WHERE s.id IS NULL
UNION ALL SELECT 'inventory_product_orphans',count(*) FROM inventory_balances b LEFT JOIN products p ON (p.organization_id,p.id)=(b.organization_id,b.product_id) WHERE p.id IS NULL
UNION ALL SELECT 'inventory_invalid_quantity',count(*) FROM inventory_balances WHERE quantity IS NULL OR quantity::text IN ('NaN','Infinity','-Infinity')
UNION ALL SELECT 'batch_store_orphans',count(*) FROM inventory_batches b LEFT JOIN stores s ON (s.organization_id,s.id)=(b.organization_id,b.store_id) WHERE s.id IS NULL
UNION ALL SELECT 'batch_product_orphans',count(*) FROM inventory_batches b LEFT JOIN products p ON (p.organization_id,p.id)=(b.organization_id,b.product_id) WHERE p.id IS NULL
UNION ALL SELECT 'unexpected_031_tables',count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('warehouses','warehouse_balances')
UNION ALL SELECT 'unexpected_manufactured_date',count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_batches' AND column_name='manufactured_date'
UNION ALL SELECT 'unexpected_031_triggers',count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgname IN ('stores_default_warehouse','inventory_warehouse_balance_sync','inventory_warehouse_partition_guard','warehouse_partition_guard','inventory_balance_identity_guard','warehouse_default_guard','stores_warehouse_default_guard','inventory_warehouse_no_truncate','warehouse_balances_no_truncate','warehouses_no_truncate')
UNION ALL SELECT 'unexpected_031_constraints',count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname IN ('warehouses_store_tenant_fk','warehouse_balances_warehouse_tenant_fk','warehouse_balances_product_tenant_fk','inventory_batch_date_order','warehouses_default_active_check','inventory_balances_quantity_finite','warehouse_balances_quantity_finite')
UNION ALL SELECT 'unexpected_031_indexes',count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('warehouses_name_unique','warehouses_default_unique','warehouse_balances_product_idx')
UNION ALL SELECT 'unexpected_031_functions',count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('create_branch_default_warehouse','sync_warehouse_balance','enforce_warehouse_partition','protect_inventory_balance_identity','assert_warehouse_partition','assert_branch_default_warehouse','enforce_branch_default_warehouse','prevent_warehouse_truncate');
-- manufactured_date must be absent before 031; the default name is a literal.
SELECT 'invalid_default_name' AS check_name,CASE WHEN length(btrim('Asosiy ombor')) BETWEEN 2 AND 120 THEN 0 ELSE 1 END AS violations;
COMMIT;
