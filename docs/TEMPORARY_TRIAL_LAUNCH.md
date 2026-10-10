# Temporary no-SMS trial launch

The default remains `required`. For an explicitly approved, time-limited exception, configure the server only:

```dotenv
TRIAL_PHONE_VERIFICATION_MODE=temporary_disabled
TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL=<explicit UTC ISO timestamp, e.g. YYYY-MM-DDTHH:mm:ssZ>
```

Missing/invalid cutoff prevents startup. At the cutoff, the server requires OTP automatically; registration is checked again after password hashing so expiry during work cannot admit an unverified trial. Switch `TRIAL_PHONE_VERIFICATION_MODE=required` and supply the documented SMS/HMAC credentials to enable verified signup. No frontend environment flag, special code or admin bypass exists.

Public `GET /api/auth/registration-config` is uncached and returns effective mode, `phoneVerificationRequired`, cutoff and server time. Register fetches this policy, hides all OTP controls in the active exception, and fails closed for trial signup if policy cannot be loaded. Paid signup remains available. The backend always enforces actual current policy even if the browser policy is stale or forged.

Temporary trials record `settings.trialPhoneVerification=TEMPORARILY_UNVERIFIED`, exception cutoff and `trial_phone_verification_deferred` audit; they do not get `phoneVerifiedAt`. SMS-verified new trials record `SMS_VERIFIED` and the actual verification timestamp. Legacy accounts are not retroactively marked verified. Existing phone-hash trial claims remain unique and transactional. Registration attempts lock IP and phone, limit8/IP/hour and5/phone/hour, and preserve failed attempts. SMS possession remains unverified in this exception; multiple controlled numbers and shared-network throttling remain limitations.

The platform-admin overview returns policy and displays an exception/cutoff warning; ordinary owners cannot access it. Existing trial14-day server timestamps, expiry restrictions, billing, sessions and paid signup are preserved.

## Release gates

Apply additive030 only after025–029 and only after authorized production preflight/approval. Original001–029 are unchanged. Migration030 adds nullable phone hash/index to existing registration attempts; old attempts and claims are retained. Tested empty disposable sequence001–024 then025–030, idempotent rerun, schema/no-drift verification and concurrency. Do not reset production or delete new state on rollback. Disable new trial admission or enforce required mode before reverting application code that lacks these controls.

Production schema could not be read: this workspace has no production database credentials/session. User reports production is at024; treat025–030 as pending until read-only verification proves otherwise. Backup provider restore exercise is still incomplete. Do not merge/deploy this backend while schema/backup/configuration readiness is unknown. Render's checked-in pre-deploy command verifies migration status and schema; it does not apply migrations. Actual dashboard deploy branch/auto-deploy settings require operator inspection.

Feature branches/PRs publish code for review; they are not a production launch. No Render/Vercel configuration or production database was changed. Do not point preview test fixtures at production. Real Neon restore drill (№11) and live SMS possession evidence (№16) remain BLOCKED; this exception does not convert either to PASS.

## Local verification commands

Use `NODE_ENV=test`, explicit loopback disposable `TEST_DATABASE_URL` and matching `DATABASE_URL`. Migration commands additionally use matching `MIGRATION_DATABASE_URL`. No production URLs in tests.

- `node --test tests/*.test.mjs` (PG-gated unit skips separately listed).
- `node --test --test-concurrency=1 tests/temporaryTrialIntegration.test.mjs tests/trialOtpIntegration.test.mjs` (separate process isolation, sequential fixture counts).
- `node --test --test-isolation=none tests/databaseIntegration.test.mjs` on the designated resettable disposable DB.
- `node --test --test-isolation=none tests/finalMigrationSequence.test.mjs` with `MIGRATION_SEQUENCE_TEST_URL` pointing to a separately created empty disposable DB.
- Frontend `node scripts/test-frontend.mjs --with-backend`, production build and `node scripts/temporary-trial-e2e.mjs` with local API/PG.

Logs/screenshots and the current status table are in the workspace's `artifacts/no-sms/` and `ZENIX_POS_NO_SMS_LAUNCH_REPORT.md`. No live customer registration was used for verification.
