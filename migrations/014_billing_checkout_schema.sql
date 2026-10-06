-- Repair billing checkout objects for databases that recorded 001_initial.sql
-- before the draft/receipt workflow was added to that historical migration.
CREATE TABLE IF NOT EXISTS billing_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type text NOT NULL,
  plan text NOT NULL DEFAULT '',
  current_end_date date,
  selected_end_date date,
  extension_days integer NOT NULL DEFAULT 0,
  base_amount numeric(18,2) NOT NULL DEFAULT 0,
  extra_store_count integer NOT NULL DEFAULT 0,
  extra_store_amount numeric(18,2) NOT NULL DEFAULT 0,
  total_amount numeric(18,2) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '2 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_draft_open_unique
  ON billing_drafts(organization_id,created_by) WHERE status='open';
CREATE UNIQUE INDEX IF NOT EXISTS billing_draft_order_unique ON billing_drafts(order_id);

CREATE TABLE IF NOT EXISTS billing_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  file_size integer NOT NULL CHECK (file_size>0 AND file_size<=5242880),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_receipts_org_idx
  ON billing_receipts(organization_id,created_at DESC);

ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS draft_id uuid REFERENCES billing_drafts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS service_period_from date,
  ADD COLUMN IF NOT EXISTS service_period_to date,
  ADD COLUMN IF NOT EXISTS extension_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_store_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS receipt_id uuid REFERENCES billing_receipts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS receipt_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS receipt_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reject_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
