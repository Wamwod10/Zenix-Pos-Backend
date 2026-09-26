-- Per-chat delivery ledger. One Telegram group failing must never make successful
-- groups receive the same business notification twice on retry.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES telegram_connections(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text NOT NULL DEFAULT '',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, connection_id)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_pending_idx
  ON notification_deliveries(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_outbox_idx
  ON notification_deliveries(outbox_id,status);
