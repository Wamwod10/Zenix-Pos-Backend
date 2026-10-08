-- Migration 021 supplies the referenced tenant/payment uniqueness first.
-- NOT VALID enforces new writes immediately. Commit this addition before
-- migration 023 validates existing rows so its stronger locks are released.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'extra_store_entitlements'::regclass
      AND conname = 'extra_store_entitlements_payment_tenant_fk'
  ) THEN
    ALTER TABLE extra_store_entitlements
      ADD CONSTRAINT extra_store_entitlements_payment_tenant_fk
      FOREIGN KEY (organization_id, payment_id)
      REFERENCES billing_payments(organization_id, id) NOT VALID;
  END IF;
END $$;
