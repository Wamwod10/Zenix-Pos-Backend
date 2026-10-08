-- Additional branch allowances are separate time-bound entitlements.
-- Historical store_limit is preserved as the legacy/base allowance; no tenant
-- data or existing branch is removed when an entitlement expires.
CREATE TABLE IF NOT EXISTS extra_store_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL UNIQUE REFERENCES billing_payments(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  duration text NOT NULL CHECK (duration IN ('MONTHLY','ANNUAL','UNTIL_LICENSE')),
  starts_on date NOT NULL,
  expires_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extra_store_positive_period CHECK (expires_on > starts_on)
);
