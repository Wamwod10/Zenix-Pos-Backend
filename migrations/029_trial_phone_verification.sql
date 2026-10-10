-- Additive pre-tenant verification state. No phone, OTP, token or IP plaintext.
CREATE TABLE auth_otp_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 phone_hash text NOT NULL CHECK(length(phone_hash)=64),
 ip_hash text NOT NULL CHECK(length(ip_hash)=64),
 code_digest text CHECK(code_digest IS NULL OR length(code_digest)=64),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 delivery_status text NOT NULL DEFAULT 'PENDING' CHECK(delivery_status IN ('PENDING','ACCEPTED','FAILED')),
 provider text NOT NULL,
 provider_message_id text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 verified_at timestamptz,
 registration_token_hash text UNIQUE,
 registration_expires_at timestamptz,
 consumed_at timestamptz,
 CHECK(registration_token_hash IS NULL OR length(registration_token_hash)=64)
);
CREATE INDEX auth_otp_phone_created_idx ON auth_otp_challenges(phone_hash,created_at DESC);
CREATE INDEX auth_otp_expiry_idx ON auth_otp_challenges(expires_at);
CREATE TABLE auth_otp_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 phone_hash text NOT NULL CHECK(length(phone_hash)=64),
 ip_hash text NOT NULL CHECK(length(ip_hash)=64),
 kind text NOT NULL CHECK(kind IN ('SEND','VERIFY')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_otp_attempt_ip_created_idx ON auth_otp_attempts(ip_hash,kind,created_at DESC);
CREATE INDEX auth_otp_attempt_phone_created_idx ON auth_otp_attempts(phone_hash,kind,created_at DESC);
