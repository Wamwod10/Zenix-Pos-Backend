-- Isolated Telegram payment-review metadata. Existing billing rows remain valid.
ALTER TABLE billing_payments
  ADD COLUMN IF NOT EXISTS telegram_review_token_hash text,
  ADD COLUMN IF NOT EXISTS telegram_review_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS telegram_admin_chat_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_admin_message_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_notification_sent_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_telegram_token_unique
  ON billing_payments(telegram_review_token_hash)
  WHERE telegram_review_token_hash IS NOT NULL;
