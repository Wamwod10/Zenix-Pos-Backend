-- Additive accounting only; no changes to POS records or existing payments.
CREATE TABLE IF NOT EXISTS ai_monthly_usage (
 organization_id uuid NOT NULL REFERENCES organizations(id), period_start date NOT NULL,
 successes integer NOT NULL DEFAULT 0 CHECK(successes>=0), reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0),
 input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0), output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros>=0), reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
 PRIMARY KEY(organization_id,period_start)
);
CREATE TABLE IF NOT EXISTS ai_daily_budget (
 day date PRIMARY KEY, spent_micros bigint NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
 reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0)
);
CREATE TABLE IF NOT EXISTS ai_requests (
 organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL, request_id uuid NOT NULL,
 period_start date NOT NULL, day date NOT NULL, fingerprint text NOT NULL, authorization_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','DISPATCHED','SUCCEEDED','FAILED')),
 reserved_cost bigint NOT NULL CHECK(reserved_cost>=0), actual_cost bigint CHECK(actual_cost>=0),
 created_at timestamptz NOT NULL DEFAULT now(), lease_ends_at timestamptz NOT NULL DEFAULT(now()+interval '90 seconds'),
 response_expires_at timestamptz, response jsonb, error_code text,
 PRIMARY KEY(organization_id,user_id,request_id),
 CONSTRAINT ai_requests_actor_tenant_fk FOREIGN KEY(organization_id,user_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,period_start) REFERENCES ai_monthly_usage(organization_id,period_start),
 FOREIGN KEY(day) REFERENCES ai_daily_budget(day)
);
CREATE INDEX IF NOT EXISTS ai_requests_rate_idx ON ai_requests(organization_id,created_at,user_id);
CREATE INDEX IF NOT EXISTS ai_requests_pending_idx ON ai_requests(organization_id,lease_ends_at) WHERE status IN ('PENDING','DISPATCHED');
