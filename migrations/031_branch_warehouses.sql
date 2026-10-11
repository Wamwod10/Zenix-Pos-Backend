-- Warehouse stock is a partition of the existing branch balance, never extra stock.
-- executeMigration wraps this entire file and its checksum record in one transaction.
-- Fail before backfill if live writers/readers hold conflicting locks. Never wait
-- while holding a weaker lock and then upgrade it behind an active sale/receipt.
SET LOCAL lock_timeout = '5s';
LOCK TABLE stores IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE products IN SHARE MODE NOWAIT;
LOCK TABLE inventory_balances, inventory_batches IN ACCESS EXCLUSIVE MODE NOWAIT;

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT warehouses_default_active_check CHECK (NOT is_default OR active),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,store_id,id),
  CONSTRAINT warehouses_store_tenant_fk FOREIGN KEY (organization_id,store_id) REFERENCES stores(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX warehouses_name_unique ON warehouses(organization_id,store_id,lower(btrim(name))) WHERE active;
CREATE UNIQUE INDEX warehouses_default_unique ON warehouses(organization_id,store_id) WHERE is_default;
CREATE TABLE warehouse_balances (
  organization_id uuid NOT NULL,
  store_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL DEFAULT 0 CONSTRAINT warehouse_balances_quantity_finite CHECK (quantity NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)),
  PRIMARY KEY (organization_id,store_id,warehouse_id,product_id),
  CONSTRAINT warehouse_balances_warehouse_tenant_fk FOREIGN KEY (organization_id,store_id,warehouse_id) REFERENCES warehouses(organization_id,store_id,id) ON DELETE CASCADE,
  CONSTRAINT warehouse_balances_product_tenant_fk FOREIGN KEY (organization_id,product_id) REFERENCES products(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX warehouse_balances_product_idx ON warehouse_balances(organization_id,store_id,product_id);
ALTER TABLE inventory_balances ADD CONSTRAINT inventory_balances_quantity_finite CHECK (quantity NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric));
INSERT INTO warehouses(organization_id,store_id,name,is_default)
  SELECT organization_id,id,'Asosiy ombor',true FROM stores;
INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity)
  SELECT b.organization_id,b.store_id,w.id,b.product_id,b.quantity FROM inventory_balances b
  JOIN warehouses w ON w.organization_id=b.organization_id AND w.store_id=b.store_id AND w.is_default;

CREATE FUNCTION create_branch_default_warehouse() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO warehouses(organization_id,store_id,name,is_default) VALUES(NEW.organization_id,NEW.id,'Asosiy ombor',true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER stores_default_warehouse AFTER INSERT ON stores FOR EACH ROW EXECUTE FUNCTION create_branch_default_warehouse();

-- Every stock path (sale, refund, transfer, count, receipt) already locks the
-- branch balance. Keep warehouse totals synchronized in that same transaction.
CREATE FUNCTION protect_inventory_balance_identity() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF (NEW.organization_id,NEW.store_id,NEW.product_id) IS DISTINCT FROM (OLD.organization_id,OLD.store_id,OLD.product_id) THEN
    RAISE EXCEPTION 'Inventory balance identity is immutable; use a stock transfer instead' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_balance_identity_guard BEFORE UPDATE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_balance_identity();

CREATE FUNCTION sync_warehouse_balance() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  main_id uuid;
  target_id uuid;
  delta numeric;
  remaining numeric;
  taken numeric;
  stock record;
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM warehouse_balances WHERE organization_id=OLD.organization_id AND store_id=OLD.store_id AND product_id=OLD.product_id;
    RETURN OLD;
  END IF;
  delta:=NEW.quantity-CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.quantity END;
  IF delta=0 THEN RETURN NEW; END IF;
  -- Default warehouses exist before any stock write. Do not INSERT on every
  -- sale: a renamed default must not collide with another warehouse's name.
  SELECT id INTO main_id FROM warehouses WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND is_default AND active FOR SHARE;
  IF main_id IS NULL THEN
    RAISE EXCEPTION 'Branch default warehouse is missing' USING ERRCODE='23514';
  END IF;
  target_id:=NULLIF(current_setting('zenix.inventory_warehouse',true),'')::uuid;
  IF target_id IS NOT NULL THEN
    PERFORM id FROM warehouses WHERE id=target_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Warehouse scope mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  IF delta>0 OR target_id IS NOT NULL THEN
    -- Update existing rows first: a valid change from a large negative to a
    -- large positive balance can have a delta larger than numeric(18,3).
    UPDATE warehouse_balances SET quantity=quantity+delta WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND warehouse_id=COALESCE(target_id,main_id) AND product_id=NEW.product_id;
    IF NOT FOUND THEN
      INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity)
        VALUES(NEW.organization_id,NEW.store_id,COALESCE(target_id,main_id),NEW.product_id,delta);
    END IF;
  ELSE
    remaining:=-delta;
    FOR stock IN SELECT b.warehouse_id,b.quantity FROM warehouse_balances b
      JOIN warehouses w ON w.id=b.warehouse_id AND w.organization_id=b.organization_id AND w.store_id=b.store_id
      WHERE b.organization_id=NEW.organization_id AND b.store_id=NEW.store_id AND b.product_id=NEW.product_id AND b.quantity>0
      ORDER BY w.is_default DESC,w.created_at,w.id FOR UPDATE OF b
    LOOP
      taken:=LEAST(remaining,stock.quantity);
      UPDATE warehouse_balances SET quantity=quantity-taken WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND warehouse_id=stock.warehouse_id AND product_id=NEW.product_id;
      remaining:=remaining-taken;
      EXIT WHEN remaining=0;
    END LOOP;
    -- Preserve explicitly permitted negative branch balances in the main warehouse.
    IF remaining>0 THEN
      INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity)
        VALUES(NEW.organization_id,NEW.store_id,main_id,NEW.product_id,-remaining)
        ON CONFLICT (organization_id,store_id,warehouse_id,product_id)
        DO UPDATE SET quantity=warehouse_balances.quantity+EXCLUDED.quantity;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_warehouse_balance_sync AFTER INSERT OR UPDATE OR DELETE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION sync_warehouse_balance();

-- Both sides are checked at COMMIT. A balanced redistribution inside one
-- transaction is permitted; a direct edit, orphan (including quantity zero),
-- or partial delete is rejected. Lock the branch row to serialize checks.
CREATE FUNCTION assert_warehouse_partition(org uuid, branch uuid, product uuid) RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  expected numeric;
  actual numeric;
  rows_count bigint;
  balance_exists boolean;
BEGIN
  SELECT quantity INTO expected FROM inventory_balances WHERE organization_id=org AND store_id=branch AND product_id=product FOR UPDATE;
  balance_exists:=FOUND;
  SELECT COALESCE(sum(quantity),0),count(*) INTO actual,rows_count FROM warehouse_balances WHERE organization_id=org AND store_id=branch AND product_id=product;
  IF (balance_exists AND actual IS DISTINCT FROM expected) OR (NOT balance_exists AND rows_count>0) THEN
    RAISE EXCEPTION 'Warehouse total differs from branch inventory balance' USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE FUNCTION enforce_warehouse_partition() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN PERFORM assert_warehouse_partition(OLD.organization_id,OLD.store_id,OLD.product_id); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM assert_warehouse_partition(NEW.organization_id,NEW.store_id,NEW.product_id); END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER inventory_warehouse_partition_guard AFTER INSERT OR UPDATE OR DELETE ON inventory_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_warehouse_partition();
CREATE CONSTRAINT TRIGGER warehouse_partition_guard AFTER INSERT OR UPDATE OR DELETE ON warehouse_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_warehouse_partition();

CREATE FUNCTION assert_branch_default_warehouse(org uuid, branch uuid) RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  -- Compatible with concurrent FK KEY SHARE locks taken by warehouse inserts.
  PERFORM id FROM stores WHERE organization_id=org AND id=branch FOR NO KEY UPDATE;
  IF FOUND AND (SELECT count(*) FROM warehouses WHERE organization_id=org AND store_id=branch AND is_default AND active)<>1 THEN
    RAISE EXCEPTION 'Branch requires exactly one active default warehouse' USING ERRCODE='23514';
  END IF;
END;
$$;
CREATE FUNCTION enforce_branch_default_warehouse() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_TABLE_NAME='stores' THEN
    IF TG_OP<>'INSERT' THEN PERFORM assert_branch_default_warehouse(OLD.organization_id,OLD.id); END IF;
    IF TG_OP<>'DELETE' THEN PERFORM assert_branch_default_warehouse(NEW.organization_id,NEW.id); END IF;
  ELSE
    IF TG_OP<>'INSERT' THEN PERFORM assert_branch_default_warehouse(OLD.organization_id,OLD.store_id); END IF;
    IF TG_OP<>'DELETE' THEN PERFORM assert_branch_default_warehouse(NEW.organization_id,NEW.store_id); END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER warehouse_default_guard AFTER INSERT OR UPDATE OR DELETE ON warehouses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_branch_default_warehouse();
CREATE CONSTRAINT TRIGGER stores_warehouse_default_guard AFTER INSERT OR UPDATE OR DELETE ON stores
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_branch_default_warehouse();

-- TRUNCATE bypasses row triggers and would silently discard the partition.
CREATE FUNCTION prevent_warehouse_truncate() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is prohibited for warehouse inventory; use transactional row operations' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER inventory_warehouse_no_truncate BEFORE TRUNCATE ON inventory_balances FOR EACH STATEMENT EXECUTE FUNCTION prevent_warehouse_truncate();
CREATE TRIGGER warehouse_balances_no_truncate BEFORE TRUNCATE ON warehouse_balances FOR EACH STATEMENT EXECUTE FUNCTION prevent_warehouse_truncate();
CREATE TRIGGER warehouses_no_truncate BEFORE TRUNCATE ON warehouses FOR EACH STATEMENT EXECUTE FUNCTION prevent_warehouse_truncate();

ALTER TABLE inventory_batches ADD COLUMN manufactured_date date;
ALTER TABLE inventory_batches ADD CONSTRAINT inventory_batch_date_order CHECK (manufactured_date IS NULL OR expiry_date IS NULL OR manufactured_date<=expiry_date);

-- Verify the initial partition before the migration checksum can be committed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM inventory_balances b FULL JOIN (
      SELECT organization_id,store_id,product_id,sum(quantity) AS quantity FROM warehouse_balances GROUP BY organization_id,store_id,product_id
    ) w USING(organization_id,store_id,product_id)
    WHERE b.product_id IS NULL OR (b.quantity IS DISTINCT FROM COALESCE(w.quantity,0))
  ) THEN RAISE EXCEPTION 'Warehouse backfill integrity check failed' USING ERRCODE='23514'; END IF;
END;
$$;
