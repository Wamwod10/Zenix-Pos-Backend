ALTER TABLE stock_transfer_items
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE product_serials
  ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES stock_transfers(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='product_serials_sale_fk'
  ) THEN
    ALTER TABLE product_serials
      ADD CONSTRAINT product_serials_sale_fk FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS product_serials_transfer_idx
  ON product_serials(organization_id, transfer_id, status)
  WHERE transfer_id IS NOT NULL;
