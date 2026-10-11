-- Warehouse stock is a partition of the existing branch balance, never extra stock.
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,store_id,id),
  FOREIGN KEY (organization_id,store_id) REFERENCES stores(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX warehouses_name_unique ON warehouses(organization_id,store_id,lower(name)) WHERE active;
CREATE UNIQUE INDEX warehouses_default_unique ON warehouses(organization_id,store_id) WHERE is_default;
CREATE TABLE warehouse_balances (
  organization_id uuid NOT NULL,
  store_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id,store_id,warehouse_id,product_id),
  FOREIGN KEY (organization_id,store_id,warehouse_id) REFERENCES warehouses(organization_id,store_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,product_id) REFERENCES products(organization_id,id) ON DELETE CASCADE
);
INSERT INTO warehouses(organization_id,store_id,name,is_default)
  SELECT organization_id,id,'Asosiy ombor',true FROM stores;
INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity)
  SELECT b.organization_id,b.store_id,w.id,b.product_id,b.quantity FROM inventory_balances b
  JOIN warehouses w ON w.organization_id=b.organization_id AND w.store_id=b.store_id AND w.is_default;

CREATE FUNCTION create_branch_default_warehouse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO warehouses(organization_id,store_id,name,is_default) VALUES(NEW.organization_id,NEW.id,'Asosiy ombor',true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER stores_default_warehouse AFTER INSERT ON stores FOR EACH ROW EXECUTE FUNCTION create_branch_default_warehouse();

-- Every stock path (sale, refund, transfer, count, receipt) already locks the
-- branch balance. Keep warehouse totals synchronized in that same transaction.
CREATE FUNCTION sync_warehouse_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  main_id uuid;
  target_id uuid;
  delta numeric(18,3);
  remaining numeric(18,3);
  taken numeric(18,3);
  stock record;
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM warehouse_balances WHERE organization_id=OLD.organization_id AND store_id=OLD.store_id AND product_id=OLD.product_id;
    RETURN OLD;
  END IF;
  delta:=NEW.quantity-CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.quantity END;
  IF delta=0 THEN RETURN NEW; END IF;
  INSERT INTO warehouses(organization_id,store_id,name,is_default)
    VALUES(NEW.organization_id,NEW.store_id,'Asosiy ombor',true)
    ON CONFLICT (organization_id,store_id) WHERE is_default DO NOTHING;
  SELECT id INTO main_id FROM warehouses WHERE organization_id=NEW.organization_id AND store_id=NEW.store_id AND is_default;
  target_id:=NULLIF(current_setting('zenix.inventory_warehouse',true),'')::uuid;
  IF target_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM warehouses WHERE id=target_id AND organization_id=NEW.organization_id AND store_id=NEW.store_id AND active) THEN
    RAISE EXCEPTION 'Warehouse scope mismatch' USING ERRCODE='23514';
  END IF;
  IF delta>0 OR target_id IS NOT NULL THEN
    INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity)
      VALUES(NEW.organization_id,NEW.store_id,COALESCE(target_id,main_id),NEW.product_id,delta)
      ON CONFLICT (organization_id,store_id,warehouse_id,product_id)
      DO UPDATE SET quantity=warehouse_balances.quantity+EXCLUDED.quantity;
  ELSE
    remaining:=-delta;
    FOR stock IN SELECT b.warehouse_id,b.quantity FROM warehouse_balances b
      JOIN warehouses w ON w.id=b.warehouse_id
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
CREATE TRIGGER inventory_warehouse_balance_sync AFTER INSERT OR UPDATE OF quantity OR DELETE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION sync_warehouse_balance();

ALTER TABLE inventory_batches ADD COLUMN manufactured_date date;
ALTER TABLE inventory_batches ADD CONSTRAINT inventory_batch_date_order CHECK (manufactured_date IS NULL OR expiry_date IS NULL OR manufactured_date<=expiry_date);
