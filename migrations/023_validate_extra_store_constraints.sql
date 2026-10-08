-- Migration 022 has committed its FK addition before this validation scan.
ALTER TABLE extra_store_entitlements
  VALIDATE CONSTRAINT extra_store_entitlements_payment_tenant_fk;
