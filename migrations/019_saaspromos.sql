-- Coupon limits are enforced under a row lock; each successful redemption is auditable.
CREATE TABLE IF NOT EXISTS platform_promos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL UNIQUE CHECK (code=upper(code) AND length(code) BETWEEN 4 AND 40),
 plan text NOT NULL DEFAULT 'BOTH' CHECK (plan IN ('MONTHLY','ANNUAL','BOTH')),
 discount_percent integer NOT NULL CHECK (discount_percent IN (20,50,75,100)),
 max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 100000),
 max_uses_per_org integer NOT NULL DEFAULT 1 CHECK (max_uses_per_org BETWEEN 1 AND 100000),
 used_count integer NOT NULL DEFAULT 0 CHECK (used_count>=0),
 expires_at timestamptz,
 active boolean NOT NULL DEFAULT true,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_promo_uses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 promo_id uuid NOT NULL REFERENCES platform_promos(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 payment_id uuid UNIQUE REFERENCES billing_payments(id) ON DELETE SET NULL,
 plan text NOT NULL CHECK (plan IN ('MONTHLY','ANNUAL')),
 discount_amount numeric(18,2) NOT NULL CHECK(discount_amount>=0),
 redeemed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_promo_uses_org_idx ON platform_promo_uses(organization_id,redeemed_at DESC);
CREATE INDEX IF NOT EXISTS platform_promo_uses_promo_org_idx ON platform_promo_uses(promo_id,organization_id);
