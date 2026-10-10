-- Additive registration abuse ledger; preserves all prior claims and attempts.
ALTER TABLE auth_registration_attempts ADD COLUMN phone_hash text CHECK(phone_hash IS NULL OR length(phone_hash)=64);
CREATE INDEX auth_registration_attempts_phone_created_idx ON auth_registration_attempts(phone_hash,created_at DESC);
