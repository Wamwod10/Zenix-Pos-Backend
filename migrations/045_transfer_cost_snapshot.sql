-- Existing in-flight transfers remain NULL and require manual review.
ALTER TABLE stock_transfer_items ADD COLUMN unit_cost_snapshot numeric(18,2)
  CHECK (unit_cost_snapshot IS NULL OR unit_cost_snapshot >= 0);

CREATE FUNCTION protect_transfer_cost_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unit_cost_snapshot IS NOT NULL AND NEW.unit_cost_snapshot IS DISTINCT FROM OLD.unit_cost_snapshot THEN
    RAISE EXCEPTION 'Transfer cost snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transfer_cost_snapshot_immutable BEFORE UPDATE ON stock_transfer_items
  FOR EACH ROW EXECUTE FUNCTION protect_transfer_cost_snapshot();
