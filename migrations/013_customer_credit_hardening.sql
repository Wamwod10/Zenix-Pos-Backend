ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_tier text NOT NULL DEFAULT 'STANDARD';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS customer_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  payment_ledger_id uuid NOT NULL REFERENCES customer_ledger(id) ON DELETE RESTRICT,
  credit_ledger_id uuid NOT NULL REFERENCES customer_ledger(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_ledger_id,credit_ledger_id)
);
CREATE INDEX IF NOT EXISTS customer_payment_allocations_credit_idx ON customer_payment_allocations(credit_ledger_id);
CREATE INDEX IF NOT EXISTS customer_payment_allocations_customer_idx ON customer_payment_allocations(organization_id,customer_id,created_at DESC);

CREATE TABLE IF NOT EXISTS customer_loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('EARN','REDEEM','ADJUSTMENT','REVERSAL')),
  points numeric(14,2) NOT NULL CHECK (points <> 0),
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_loyalty_org_customer_idx ON customer_loyalty_ledger(organization_id,customer_id,created_at DESC);
