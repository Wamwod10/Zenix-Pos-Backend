CREATE TABLE IF NOT EXISTS auth_registration_attempts (
  id bigserial PRIMARY KEY,
  ip_address text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_registration_attempts_ip_created_idx
  ON auth_registration_attempts(ip_address, created_at DESC);
