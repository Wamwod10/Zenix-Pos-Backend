-- Production security hardening: tenant-aware notification idempotency and login throttling.

ALTER TABLE notification_outbox
  DROP CONSTRAINT IF EXISTS notification_outbox_event_type_event_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_org_event_unique
  ON notification_outbox(organization_id,event_type,event_id);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id bigserial PRIMARY KEY,
  username_norm text NOT NULL,
  ip_address text NOT NULL DEFAULT '',
  success boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_lookup_idx
  ON auth_login_attempts(username_norm,ip_address,created_at DESC);
CREATE INDEX IF NOT EXISTS auth_login_attempts_cleanup_idx
  ON auth_login_attempts(created_at);
