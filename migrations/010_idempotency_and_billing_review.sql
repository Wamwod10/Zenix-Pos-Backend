-- Backward-compatible concurrency/idempotency hardening. Existing rows are preserved.
ALTER TABLE sale_returns ADD COLUMN IF NOT EXISTS client_reference text;
CREATE UNIQUE INDEX IF NOT EXISTS sale_returns_org_client_reference_unique
  ON sale_returns(organization_id,client_reference)
  WHERE client_reference IS NOT NULL AND client_reference<>'';

-- Preserve historical duplicate review rows but close all except the newest one so
-- the database can enforce one pending review per organization/type going forward.
WITH ranked AS (
  SELECT id,row_number() OVER (PARTITION BY organization_id,type ORDER BY submitted_at DESC,id DESC) AS rn
  FROM billing_payments WHERE status='REVIEW'
)
UPDATE billing_payments bp
SET status='REJECTED',reject_reason=COALESCE(NULLIF(bp.reject_reason,''),'Superseded duplicate review during idempotency migration'),reviewed_at=COALESCE(bp.reviewed_at,now())
FROM ranked r WHERE bp.id=r.id AND r.rn>1;
CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_one_review_per_type
  ON billing_payments(organization_id,type) WHERE status='REVIEW';
