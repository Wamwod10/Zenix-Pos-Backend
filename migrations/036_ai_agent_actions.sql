-- Pending AI previews are separate from stock. Only explicit confirmation writes inventory.
CREATE TABLE ai_agent_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL, session_id uuid NOT NULL REFERENCES auth_sessions(id),
 request_id uuid NOT NULL, conversation_id uuid NOT NULL,
 authorization_key text NOT NULL, type text NOT NULL CHECK(type='stock_receipt'),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED','STALE')),
 payload jsonb NOT NULL, fingerprint text NOT NULL,
 product_snapshot jsonb NOT NULL, warehouse_snapshot jsonb NOT NULL,
 preview jsonb NOT NULL, confirmation_token text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT(now()+interval '5 minutes'),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 FOREIGN KEY(organization_id,user_id) REFERENCES users(organization_id,id),
 FOREIGN KEY(organization_id,user_id,request_id) REFERENCES ai_requests(organization_id,user_id,request_id),
 UNIQUE(organization_id,user_id,request_id)
);
CREATE INDEX ai_agent_actions_pending_idx ON ai_agent_actions(organization_id,expires_at) WHERE status='PENDING';
