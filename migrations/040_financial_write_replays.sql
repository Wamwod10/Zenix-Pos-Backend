-- Completed outcomes only; business mutation and replay outcome commit atomically.
-- No historical business rows are modified or backfilled.
CREATE TABLE IF NOT EXISTS financial_write_replays (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 operation text NOT NULL CHECK (operation IN ('supplier_payment','expense_create')),
 client_reference text NOT NULL CHECK (length(client_reference) BETWEEN 1 AND 120),
 user_id uuid NOT NULL,
 request_fingerprint text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id,operation,client_reference),
 CONSTRAINT financial_replays_actor_tenant_fk FOREIGN KEY (organization_id,user_id)
  REFERENCES users(organization_id,id) ON DELETE CASCADE
);
