-- Preserve the applied 031 checksum; repair only missing zero warehouse rows.
-- executeMigration commits DDL, backfill and checksum together or rolls all back.
SET LOCAL lock_timeout = '5s';
LOCK TABLE stores IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE products IN SHARE MODE NOWAIT;
LOCK TABLE inventory_balances, inventory_batches, warehouses, warehouse_balances IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Reject other corruption without silently modifying business quantities.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM inventory_balances b FULL JOIN (
      SELECT organization_id,store_id,product_id,sum(quantity) AS quantity
      FROM warehouse_balances GROUP BY organization_id,store_id,product_id
    ) w USING(organization_id,store_id,product_id)
    WHERE b.product_id IS NULL OR b.quantity IS DISTINCT FROM COALESCE(w.quantity,0)
  ) THEN RAISE EXCEPTION 'Existing warehouse partition is inconsistent' USING ERRCODE='23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM stores s LEFT JOIN warehouses w
      ON w.organization_id=s.organization_id AND w.store_id=s.id AND w.is_default AND w.active
    GROUP BY s.organization_id,s.id HAVING count(w.id)<>1
  ) THEN RAISE EXCEPTION 'Branch default warehouse is inconsistent' USING ERRCODE='23514'; END IF;
END;
$$;

INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity)
SELECT b.organization_id,b.store_id,w.id,b.product_id,0
FROM inventory_balances b JOIN warehouses w
  ON w.organization_id=b.organization_id AND w.store_id=b.store_id AND w.is_default AND w.active
WHERE b.quantity=0 AND NOT EXISTS (
  SELECT 1 FROM warehouse_balances wb
  WHERE wb.organization_id=b.organization_id AND wb.store_id=b.store_id AND wb.product_id=b.product_id
);

-- A tuple write serializes deferred checks even under REPEATABLE READ.
-- A row lock alone does not invalidate another transaction's old snapshot.
ALTER TABLE inventory_balances ADD CONSTRAINT inventory_balances_scope_unique UNIQUE(organization_id,store_id,product_id);
CREATE TABLE warehouse_partition_versions (
  organization_id uuid NOT NULL,
  store_id uuid NOT NULL,
  product_id uuid NOT NULL,
  epoch boolean NOT NULL DEFAULT false,
  PRIMARY KEY(organization_id,store_id,product_id),
  CONSTRAINT warehouse_partition_versions_balance_tenant_fk
    FOREIGN KEY(organization_id,store_id,product_id)
    REFERENCES inventory_balances(organization_id,store_id,product_id) ON DELETE CASCADE
);
INSERT INTO warehouse_partition_versions(organization_id,store_id,product_id)
  SELECT organization_id,store_id,product_id FROM inventory_balances;

CREATE OR REPLACE FUNCTION sync_warehouse_balance() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
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
  -- Default warehouses exist before any stock write. Do not INSERT on every
  -- sale: a renamed default must not collide with another warehouse's name.
  SELECT id INTO main_id FROM warehouses WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND is_default AND active FOR SHARE;
  IF main_id IS NULL THEN
    RAISE EXCEPTION 'Branch default warehouse is missing' USING ERRCODE='23514';
  END IF;
  IF delta=0 THEN
    IF TG_OP='INSERT' THEN
      INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity)
        VALUES(NEW.organization_id,NEW.store_id,main_id,NEW.product_id,0)
        ON CONFLICT (organization_id,store_id,warehouse_id,product_id) DO NOTHING;
    END IF;
    RETURN NEW;
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
CREATE OR REPLACE FUNCTION assert_warehouse_partition(org uuid, branch uuid, product uuid) RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  expected numeric;
  actual numeric;
  rows_count bigint;
  balance_exists boolean;
BEGIN
  SELECT quantity INTO expected FROM inventory_balances WHERE organization_id=org AND store_id=branch AND product_id=product FOR UPDATE;
  balance_exists:=FOUND;
  IF balance_exists THEN
    INSERT INTO warehouse_partition_versions(organization_id,store_id,product_id)
      VALUES(org,branch,product)
      ON CONFLICT(organization_id,store_id,product_id)
      DO UPDATE SET epoch=NOT warehouse_partition_versions.epoch;
  END IF;
  SELECT COALESCE(sum(quantity),0),count(*) INTO actual,rows_count FROM warehouse_balances WHERE organization_id=org AND store_id=branch AND product_id=product;
  IF (balance_exists AND (rows_count=0 OR actual IS DISTINCT FROM expected)) OR (NOT balance_exists AND rows_count>0) THEN
    RAISE EXCEPTION 'Warehouse total differs from branch inventory balance' USING ERRCODE='23514';
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM inventory_balances b FULL JOIN (
      SELECT organization_id,store_id,product_id,sum(quantity) AS quantity
      FROM warehouse_balances GROUP BY organization_id,store_id,product_id
    ) w USING(organization_id,store_id,product_id)
    WHERE b.product_id IS NULL OR w.product_id IS NULL OR b.quantity IS DISTINCT FROM w.quantity
  ) THEN RAISE EXCEPTION 'Warehouse presence integrity check failed' USING ERRCODE='23514'; END IF;
END;
$$;
