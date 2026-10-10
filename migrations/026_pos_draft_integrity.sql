-- Additive: do not mutate historical sales/refunds or existing holds.
ALTER TABLE sale_holds ADD COLUMN IF NOT EXISTS customer_id uuid;
ALTER TABLE sale_holds ADD COLUMN IF NOT EXISTS client_reference text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS sale_holds_org_client_reference_unique
 ON sale_holds(organization_id,client_reference) WHERE client_reference<>'';
ALTER TABLE sale_holds ADD CONSTRAINT sale_holds_customer_tenant_fk
 FOREIGN KEY (organization_id,customer_id) REFERENCES customers(organization_id,id) NOT VALID;
