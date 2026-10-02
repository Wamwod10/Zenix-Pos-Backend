CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  customer_type text NOT NULL DEFAULT 'REGULAR',
  credit_limit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  default_credit_days integer NOT NULL DEFAULT 0 CHECK (default_credit_days >= 0),
  note text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_org_name_idx ON customers(organization_id,lower(name));
CREATE INDEX IF NOT EXISTS customers_org_phone_idx ON customers(organization_id,phone);

CREATE TABLE IF NOT EXISTS customer_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  sale_id uuid REFERENCES sales(id) ON DELETE SET NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('CREDIT_SALE','PAYMENT','REFUND','REVERSAL','ADJUSTMENT')),
  amount numeric(14,2) NOT NULL CHECK (amount <> 0),
  due_date date,
  payment_method text,
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_ledger_org_customer_created_idx ON customer_ledger(organization_id,customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS customer_ledger_org_due_idx ON customer_ledger(organization_id,due_date) WHERE amount > 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS sales_org_customer_created_idx ON sales(organization_id,customer_id,created_at DESC) WHERE customer_id IS NOT NULL;
