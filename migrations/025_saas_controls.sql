-- Additive controls; existing coupons and sessions remain compatible.
ALTER TABLE platform_promos ADD COLUMN IF NOT EXISTS starts_at timestamptz;
CREATE TABLE IF NOT EXISTS password_reset_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS organization_trial_claims (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
 phone_hash text NOT NULL UNIQUE,
 claimed_at timestamptz NOT NULL DEFAULT now()
);
-- Existing trial history is preserved; duplicate contacts retain their first claim.
INSERT INTO organization_trial_claims(organization_id,phone_hash,claimed_at)
SELECT DISTINCT ON (regexp_replace(phone,'[^0-9]','','g'))
 id,encode(digest('phone:'||regexp_replace(phone,'[^0-9]','','g'),'sha256'),'hex'),created_at
FROM organizations
WHERE settings->>'trialUsed'='true' AND regexp_replace(phone,'[^0-9]','','g')~'^998[0-9]{9}$'
ORDER BY regexp_replace(phone,'[^0-9]','','g'),created_at,id
ON CONFLICT DO NOTHING;
