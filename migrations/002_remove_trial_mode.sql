-- Zenix POS production licensing has no demo/trial workspace mode.
ALTER TABLE organizations ALTER COLUMN license_status SET DEFAULT 'PAYMENT_REQUIRED';
UPDATE organizations SET license_status='PAYMENT_REQUIRED',updated_at=now() WHERE upper(license_status)='TRIAL';

CREATE UNIQUE INDEX IF NOT EXISTS telegram_connections_chat_id_unique ON telegram_connections(chat_id);
