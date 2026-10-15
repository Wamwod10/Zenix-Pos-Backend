-- Additive, application-scoped AI context. Never apply automatically at startup.
CREATE TABLE IF NOT EXISTS ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES auth_sessions(id),
  store_id uuid REFERENCES stores(id),
  authorization_key text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages)='array'),
  active_request_id uuid,
  active_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
CREATE INDEX IF NOT EXISTS ai_conversations_actor_idx ON ai_conversations(organization_id,user_id,session_id,expires_at);
