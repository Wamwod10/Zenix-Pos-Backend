-- Additive provenance only: historical repayments and movements remain untouched.
ALTER TABLE customer_ledger ADD COLUMN shift_id uuid;
ALTER TABLE customer_ledger ADD COLUMN register_id uuid;
ALTER TABLE customer_ledger ADD COLUMN repayment_client_reference text;
ALTER TABLE customer_ledger ADD CONSTRAINT customer_repayment_shift_tenant_fk
 FOREIGN KEY(organization_id,shift_id) REFERENCES shifts(organization_id,id);
ALTER TABLE customer_ledger ADD CONSTRAINT customer_repayment_register_tenant_fk
 FOREIGN KEY(organization_id,store_id,register_id) REFERENCES pos_registers(organization_id,store_id,id);
ALTER TABLE customer_ledger ADD CONSTRAINT customer_repayment_cash_provenance CHECK (
 (shift_id IS NULL AND register_id IS NULL) OR
 (entry_type='PAYMENT' AND payment_method='cash' AND amount<0 AND store_id IS NOT NULL
  AND shift_id IS NOT NULL AND register_id IS NOT NULL AND repayment_client_reference IS NOT NULL
  AND length(btrim(repayment_client_reference))>0));
CREATE UNIQUE INDEX customer_repayment_reference_unique ON customer_ledger(organization_id,repayment_client_reference)
 WHERE repayment_client_reference IS NOT NULL;
ALTER TABLE shift_movements ADD COLUMN customer_payment_ledger_id uuid;
ALTER TABLE shift_movements ADD CONSTRAINT shift_movement_customer_payment_tenant_fk
 FOREIGN KEY(organization_id,customer_payment_ledger_id) REFERENCES customer_ledger(organization_id,id);
ALTER TABLE shift_movements ADD CONSTRAINT shift_movement_customer_payment_shape CHECK (
 customer_payment_ledger_id IS NULL OR (source='customer_payment' AND type='in' AND reference_id=customer_payment_ledger_id::text));
CREATE UNIQUE INDEX shift_movement_customer_payment_unique ON shift_movements(customer_payment_ledger_id)
 WHERE customer_payment_ledger_id IS NOT NULL;
