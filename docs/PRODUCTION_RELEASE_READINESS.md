# Zenix POS — production release readiness

Final inspection date:2026-10-13Asia/Tashkent (2026-10-12 19:03UTC). Remote main SHAs were rechecked unchanged.

## Decision: NO-GO for production; local candidate verified

Three-tier billing, subscription, resource limits, frontend and disabled AI integration pass the local checks below. Production migration, main merge, Render/Vercel deployment and public AI activation have not been performed. External production-shaped staging, a fresh Neon snapshot and a verified provider restore remain mandatory gates. Read-only credentials/staging were requested; the proposed `%TEMP%/zenix-release-readonly.env` was still absent at the final inspection. Local rehearsal is not claimed to be external staging.

## Requirement evidence

| Requirement | Observed result | Evidence / limitation |
| --- | --- | --- |
| Prices across server, DB and frontend | Local PASS | `releaseIntegration.test.mjs` compares all stored plan snapshots with `SUBSCRIPTION_CATALOG` and authenticated catalogue; Chromium consumes the real API. Current production still serves the previous release. |
| Start product limit | PASS: exactly750 | DB snapshot, API limit, boundary/parallel creation tests; inventory-created products also count. |
| All resource limits | PASS | Start2/1/1/1/750/500; Business7/2/3/3/10000/unlimited; Premium25/10/15/10/unlimited/unlimited. Order: active staff excluding owner/branches/warehouses/active registers/products/customers. Main branch/warehouse count; business-wide concurrency tests pass. |
| Standard POS modules in all tiers | PASS for authorized roles | Owner bootstrap/products/customers/finance/suppliers/users/registers/warehouses succeed in each tier. Plan does not bypass role permissions or independently configured business-module preferences. |
| Selected14-day trial; switching without restart | PASS locally | Real registration/DB and Chromium tests check exact14-day timestamp interval and unchanged deadline. Local registration uses the existing bounded test-only no-SMS policy; live SMS was not invoked. |
| Expiration/read-only bypass | PASS | Trial and paid expiration tests retain authorized GET/login/billing access, reject business mutations at API and DB layers, and recheck after lock waits. Platform operations require their existing platform role. |
| Monthly/yearly, promo, receipt/review, renewal | PASS locally | Exact server-price/tiyin math; pending receipt does not activate; zero-due100% promo and repeated approval are idempotent. Payment/Telegram transports were not sent to production. |
| Upgrade/downgrade | PASS locally | Actual paid-term unused credit, calendar periods, exact .01UZS rounding, wallet overflow, delayed approval and next-period downgrade; no automatic resource deletion/deactivation. |
| AI0/100/500 and no rollover | PASS locally | Server tier source; concurrent final slots, retained usage across upgrade/downgrade/trial changes, calendar-month isolation. Month resets00:00 Asia/Tashkent, including annual plans. |
| AI permissions/tenant isolation | PASS at application/provider contract boundary | Read-only fixed aggregate queries, branch/seller restrictions, session/permission rechecks, anonymous provider facts, validated fact/advice IDs. No arbitrary SQL, tools or business writes. |
| Legacy POS/stock/staff/debt regressions | PASS locally | Modern release DB/API59 tests and legacy CI PG59 tests; tests execute separately so schema-recreating legacy tests cannot collide with modern fixtures. |
| Responsive/frontend themes | PASS locally | Billing Chromium7 and AI Chromium6;390/768/1440px, actual light/dark class, no page overflow. AI paid boundary alone is substituted in its test server. |
| Migrations on staging | PARTIAL | Isolated local001–032 baseline →033–035, replay, schema and populated dump/restore passed. External staging and Neon-role/volume/lock behavior are unverified. |

Annual prices: Start2,500,000UZS, Business3,300,000UZS, Premium5,900,000UZS. Monthly:250,000/350,000/590,000UZS. Annual savings derived from12monthly payments:500,000/900,000/1,180,000UZS. Backend is the price/status authority; client prices are not accepted as payment authority.

## Fresh test results

| Check | Result |
| --- | --- |
| Backend full unit/contract suite |447passed,0failed,41opt-in DB tests skipped |
| Frontend combined suite |342passed,0failed,2opt-in browser tests skipped |
| Modern real-PG/API release/billing/resources/AI suite |59passed,0failed |
| Legacy CI `databaseIntegration.test.mjs` in its own disposable DB |59passed,0failed after fixture/date corrections |
| Billing actual Chromium → Vite → Express → PG |7passed |
| AI actual Chromium → Vite → authenticated Express → PG |6passed; paid provider boundary replaced |
| Recovery/manifest/CLI/CI-gate tests |14passed |
|001–032 historical rows →033–035/replay |1passed |
| Populated real-PG modern recovery manifest/integrity |1passed |
| Offline pg_dump → new DB pg_restore → full row-fingerprint comparison |`complete:true`, zero tenant-integrity violations; `providerRestoreVerified:false` |
| Schema/checksums |61tables,35migrations,181indexes; no missing/drifted/unverified entries |
| Frontend build/design/packaging |PASS;23stylesheet baselines; standalone production-readiness script passes |
| Backend syntax |120modules PASS |

Results overlap; do not add them into a fabricated unique-test total. Fresh evidence logs reside in the OS temp directory (`zenix-release-*`). Initial failures were investigated: missing recovery tables, name[] driver parsing, skipped modern CI gates, obsolete inactive/date fixtures, and misclassified payment-pending errors. Final selected checks pass. Remote CI for these uncommitted changes has not run.

## Audit fixes in this phase

- Added `tests/releaseIntegration.test.mjs`: DB/config/API equivalence, all-tier authorized modules, trial read-only and AI limits.
- Added read-only `scripts/inspectRelease.mjs`: public health plus optional authenticated Render/Neon/staging metadata. It issues GET and read-only DB transactions only; it never migrates, snapshots, restores or deploys and never prints connection strings/tokens.
- Extended `src/services/tenantRecovery.js` with paid terms/events, POS registers, composite AI usage/request keys and shared catalogue/daily budget hashes. Data stays bounded and read-only; only counts/digests leave the verifier. A tenant table exceeding5000rows fails closed; large staging restores require a reviewed complete comparison strategy rather than a false success.
- Fixed `src/db/auditIntegrity.js` to aggregate PostgreSQL catalogue names as `text[]`, verified against actual PG. Previous mocks had missed this driver-type failure.
- Extended `.github/workflows/verify.yml` with serialized modern integrations and a distinct empty migration DB, populated recovery fixture, dump/restore and comparison. No deploy workflow or production settings were changed; these edits remain local.
- Updated legacy DB fixtures to create legitimately active synthetic tenants and use current calendar boundaries. Reordered `storeTradingHolds.js` status explanation so unpaid/review states retain `PAYMENT_REQUIRED`/`LICENSE_REVIEW`; all402write protections remain. Regression tests cover this distinction.

## Git and actual hosting evidence

| Surface | Actual observed state |
| --- | --- |
| Backend local |`codex/registration-error-feedback`, baseHEAD `4c2f3a6b75f7e526fba31295abf41aac986961f8`; all release edits uncommitted |
| Frontend local |`codex/logo-unclipped`, baseHEAD `3e2c97ff1bf645f847f9aba16c124b6801ed28ce`; all release edits uncommitted |
| Backend remote main |[85e8c0c](https://github.com/Wamwod10/Zenix-Pos-Backend/commit/85e8c0c38a712f0cfbb601f3b7c9890ca045bd4d), existing [PR2](https://github.com/Wamwod10/Zenix-Pos-Backend/pull/2) merged; [Verify Backend](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/38235364759) success |
| Frontend remote main |[db2ae4bd](https://github.com/Wamwod10/Zenix-Pos/commit/db2ae4bdc0eaba354e31d31eafcdc5f412c32fd2), existing [PR7](https://github.com/Wamwod10/Zenix-Pos/pull/7) merged; [Verify Frontend](https://github.com/Wamwod10/Zenix-Pos/actions/runs/38246703975) success |
| Candidate PR/commit |None created for three-tier/AI work. The linked old PRs contain previous releases only. Base local trees equal current remote-main trees; no drift at final recheck. New isolated release branches/commits/PRs must package these changes before remote checks can attest them. |
| Main protection |GitHub branch reads report both main branches unprotected. No repository security setting was changed. Enforce explicit reviewed merge/check discipline before release. |
| Vercel |Project `zenix-pos`, `prj_WXAsxt3fynyhlLflV2xIE1PvSr9j`, team `team_lMTGaZoYkeYcisAxh4Y8YrK7`. Project/deployment detail requests returned403forbidden for `shamshods-projects-9be974ef`; CLI absent; no unchanged retry or silent success. |
| Vercel alternative evidence |GitHub status for current frontend main is `Vercel:success`, linked [deployment status target](https://vercel.com/shamshods-projects-9be974ef/zenix-pos/DiCWB8hwwHNMhYecpVgedHpTRUxq). Domain [zenixpos.uz](https://zenixpos.uz/) responds200with Vercel headers. This does not attest the uncommitted candidate. |
| Backend public runtime |Domain `/health` and `/ready` respond200with `zenix-pos-api`/`database:ready`, proving the current proxied API is alive. Render service ID, deployment status/commit and worker rollout remain unverified without read-only access. |
| Public AI |`GET /api/ai/status` returns404NOT_FOUND on current production; new AI routes are not publicly released. No authenticated production tenant or paid provider call was exercised. |
| Neon |Production001–032is user-reported. Exact current migration rows, snapshot ID/status/time, history retention and provider restore have not been independently verified. No production DB connection or operation was made. |
| External staging |Not configured/verified at final inspection. No Render/Vercel staging deployment was created. |

After explicit approval, existing GitHub-connected deployments are the first fallback: reviewed release PR → pinned commit/main merge → actual CI/Vercel status → live domain artifact/API smoke tests. A successful push alone is not deployment success. If the Vercel API remains403, require matching GitHub deployment status, domain build-asset fingerprint and functional smoke evidence; use the operator's authenticated dashboard for missing deployment details. Do not invoke an unrelated team/project or install/re-authenticate tools automatically.

## Production-affecting migrations and release sequence

Only033,034and035are new production migrations.001–032must remain applied and checksum-verified; never rerun their SQL or reset/seed production. The existing migration runner skips recorded migrations; checksum drift/missing older entries must abort the production procedure, not trigger baseline recreation. Null historical checksums require reviewed adoption before claiming verified history.

1. **Before production approval:** package reviewed backend/frontend release candidates with exact SHAs; run candidate CI. Confirm named, separate staging project/branch/services with production-compatible PG roles/version/shape, without exposing private business data in logs. Apply033→034→035there; run modern/legacy/API/browser/recovery and lock/import-load checks. Local results are supporting evidence, not a substitute.
2. **Fresh snapshot gate:** after explicit approval for this action, create a new Neon snapshot of the verified production project/branch; record snapshot/operation IDs, capture timestamp/LSN and operation completion. Validate a restore to a separate recovery branch with `finalize_restore:false`, never overwrite the shared branch. Existing PITR configuration or a snapshot-list row withUNKNOWNreadiness is insufficient. Freeze/identify the migration window and record post-snapshot write reconciliation procedures.
3. **Migration approval gate:** explicit approval for033–035against the verified production branch/direct endpoint. Confirm baseline001–032, exact catalogue/checksums and backup evidence; use the existing transactional/advisory-lock migration runner.033adds organization fields and immutable price/paid-term/event snapshots, plus database write guards.034creates/backfills registered POS workplaces, links existing shifts, and adds resource/lifecycle guards.035adds AI quota/request/cost accounting only. No row deletion/reset/seed is required. DDL and backfills take locks; use a quiet window and abort on timeout instead of disabling guards.
4. **Backend first:** verify schema, migration checksums and zero tenant-integrity violations; then approve/merge the pinned backend commit and deploy both Render API and worker consistently. `render.yaml` pre-deploy command checks `migrate:status`/`db:verify` and does not apply migrations. Verify actual Render deployment IDs/status/commit, `/ready`, auth, catalogue, allowed reads, denied writes, payment replay and resource boundaries. Keep every AI activation flagfalse.
5. **Frontend second:** approve/merge/deploy the matching frontend commit only after the backend contract is proven. Verify actual Vercel status/commit/domain aliases or the approved GitHub fallback; compare served hashed build assets, test registration/billing/read-only and390/768/1440light/dark views. Existing Vercel proxy/backend environment must target the verified API. SPA navigation is network-first; API responses are not cached by the service worker. Test a browser carrying the prior app shell as well as a fresh session.
6. **AI separately:** approved paid project/key/privacy terms, live staging model transport/usage/latency/Uzbek-quality evaluation and spend reconciliation first. Public production AI needs its own explicit approval. There is no automatic fallback to an unapproved provider.

AI has explicit disabled-by-default approval/production flags. Billing/resource guards have no global off switch: do not claim a nonexistent canary flag or disable integrity triggers. Existing `plan_code=NULL` legacy tenants retain their legacy path; resource caps are not silently forced onto them and AI is unavailable until explicit tier mapping. Start with reviewed tenant conversions and monitor, while new chosen-tier signups use the new contract. Legacy prepaid value lacking trustworthy terms requires administrator review. Some retained legacy store allowances are compatibility rights, not newly sold add-ons.

## AI cost and security state

Implemented provider candidate:Gemini2.5Flash-Lite, server-only key, fixed HTTPS origin, no redirects/retries/tools/thinking. Anonymous numeric facts only; model selects existing fact/advice IDs and server renders the answer. At8000input/1200output and published $0.10/$0.40per million rates, estimate$0.00128per successful maximal-token request. Reserve$0.002per request; exact validated success settles actual integer micro-USD cost; uncertain dispatched failure conservatively keeps reserve but releases request quota. Business/Premium independent monthly spend caps$0.50/$2.50; global daily$25;3attempts/user/minute,10/business/minute,2concurrent; report/provider deadline20swith2sSQL timeouts. Budget admission/settlement/recovery is short and lock-bounded; no locks are held across provider calls.

No paid model call was made. Live availability, provider billing totals, latency and generated selection quality remain unverified. Pricing/privacy references and backend flags are detailed in [ZENIX_AI.md](ZENIX_AI.md). Provider failure/quota exhaustion preserve ordinary POS routes. Expired result retention, crash leases, privacy-safe logs and cross-tenant contention are tested. Default public AI activation remains off.

## Rollback

- Before applying migrations: abort and leave the current release running if staging, backup, checksum or target identity fails.
- During migration: transaction failure rolls back that migration; retain successful earlier additive migrations and evaluate the resulting state. Do not assume all three form one transaction.
- After migration but before new writes: retain additive schema and guards; use a reviewed compatible application rollback. Migration034register backfill and033historical anchor fields are preserved. Never drop terms/events/register/quota tables as a shortcut.
- After modern payments/workplaces exist: a blind rollback to the old billing/shift implementation is unsafe. Prefer a forward fix or a compatible paired backend/frontend artifact that understands existing contracts. Never reverse approved financial entries, auto-delete excess resources or bypass read-only/resource guards.
- AI rollback: stop admission by clearing enabled flags, keep settlement/lease recovery active until in-flight reservations are reconciled, then stop maintenance as appropriate. Disabling AI must not discard accounting.
- Data recovery: restore the verified snapshot to a new isolated branch; compare all scoped and shared state and zero tenant-FK violations. Reconcile sales/stock/payments since capture before an explicitly approved cutover. Do not restore an old snapshot in place and lose intervening production writes. Snapshot creation/restore/cutover each need explicit authorization; none occurred here.

## Outstanding release gates

External staging and load/Neon-role checks; new reviewed release commits/PRs and actual remote CI; fresh production snapshot/isolated provider restore proof; actual Render API+worker deployment SHAs; Vercel detail access or fully validated GitHub/domain fallback; live AI/provider quality/cost approval. Until these pass, production remains NO-GO. This report does not request premature production execution approval.

## Complete workspace change inventory

## Stage7 update — preserved candidates and isolated staging configuration

The earlier inspection above is historical. Stage7 preserves the same application/database work on new `codex/three-tier-ai-release` branches. Feature commits/draft PRs are authorized; main merge, production migration/deployment and paid AI remain prohibited. User confirmed that the existing shared branch shift must remain: registered POS workplaces are separate identities, not independent cash drawers; one open shared shift per branch is retained.

Vercel preview proxy now requires `ZENIX_STAGING_BACKEND_URL`. It cannot fall back to `ZENIX_BACKEND_URL` and rejects a staging origin equal to the production origin. Missing staging configuration returns503without fetching upstream. Production/development proxy behavior is unchanged. This prevents a newly opened draft PR preview from accidentally using the inherited production backend.

### Operator actions to unblock external staging

1. Create a separately named Neon staging project/branch and a separate role/database; record project/branch/endpoint IDs and ensure the endpoint differs from production. Do not reset/copy back into production. An isolated sanitized production-shaped copy is preferable; the local synthetic rehearsal does not validate actual production volume or Neon permissions.
2. Create a staging Render API service and, if needed, its staging worker using the release backend branch. Disable production auto-deploy wiring for these resources. Provide only staging `DATABASE_URL` and a staging direct `MIGRATION_DATABASE_URL` with TLS, a separate session/cookie namespace, staging frontend origins and staging `PUBLIC_API_URL`. Never paste credentials into commits or chat.
3. For functional staging with no external transports, use the already-tested `NODE_ENV=test` configuration, no Telegram/SMS/AI provider keys, `RUN_NOTIFICATION_WORKERS=false`, and a bounded test-only trial admission policy. All data must be synthetic. This is a functional test environment, not proof of production-mode infrastructure parity. Validate production-mode requirements separately before GO; use dedicated staging bots/providers only with explicit approval.
4. On Vercel **Preview only**, set `ZENIX_STAGING_BACKEND_URL` to that staging API and keep `VITE_API_URL` empty for the same-origin proxy. Production retains its existing `ZENIX_BACKEND_URL`. Do not copy production Telegram/payment/AI secrets to Preview. The frontend does not need provider keys.
5. Confirm baseline001–032/checksums on staging, then run only missing033→034→035using the existing runner. Abort if baseline drift/target identity/permissions are ambiguous. Run `db:verify`, `db:audit-integrity`, subscription integrity, real API/browser checks and a staging-only dump/restore drill. Never use the destructive legacy CI test suite on an external shared staging database; its schema-recreation cases belong only in isolated local/CI PostgreSQL.
6. For read-only inspection, configure `%TEMP%/zenix-release-readonly.env` with the staging connection and least-privilege Render/Neon metadata credentials, then run `node scripts/inspectRelease.mjs`. `PRODUCTION_DATABASE_URL`, if explicitly supplied, is read via `BEGIN READ ONLY` only. This script never applies migrations or creates snapshots/restores/deployments.

Stage7 cannot provision or attest external resources without that access. Fresh production snapshot and provider restore proof remain prerequisites; no production migration plan is GO merely because local tests or CI pass. AI remains disabled: candidate model/rates, backend flags and cost methodology stay documented in `ZENIX_AI.md`; no live paid integration is claimed.

### Release stops and rollback per step

| Step | Stop condition | Safe response |
| --- | --- | --- |
| New Neon snapshot | Wrong project/branch, missing snapshot/operation completion or restore proof | Stop; leave production untouched |
| Pre-migration integrity | Baseline checksum/schema/tenant-FK mismatch | Stop and investigate; no baseline rerun/reset |
|033then034then035 | DDL lock timeout, constraint/backfill failure | Roll back the failing migration transaction; retain completed additive state and inspect |
| Render API/worker | Wrong SHA, failed deploy/readiness/API contract | Retain/restore compatible application artifact; never disable DB guards |
| Vercel frontend | Wrong SHA/domain/backend target, preview fallback or failed smoke | Keep previous compatible frontend; production settings require separate approval |
| Billing/read-only/stock smoke | Financial mismatch, bypass, tenant leak | Stop rollout; preserve documents/history; use a forward-compatible fix |
| Public AI feature flag | Missing live staging/privacy/cost approval or quota/timeout failure | Keep flagsfalse; POS remains available; settle existing reservations before disabling maintenance |

Commit/PR creation does not authorize any step above or prove deployment success. Verify actual remote checks and deployments for the pinned release SHA, not the old main commit.

Inventory below is against each repository's current localHEAD and includes retained prior-phase work. `M`means tracked modification; `??`means new/untracked. No commit/push/merge/deploy was performed in this audit. Root `PHASE4_PROGRESS.md` is also updated.

### backend

```text
M .github/workflows/verify.yml
 M src/app.js
 M src/db/auditIntegrity.js
 M src/db/tx.js
 M src/db/verifySchema.js
 M src/middleware/auth.js
 M src/middleware/error.js
 M src/middleware/workspaceRevision.js
 M src/routes/auth.js
 M src/routes/billing.js
 M src/routes/bootstrap.js
 M src/routes/shifts.js
 M src/routes/stores.js
 M src/routes/users.js
 M src/server.js
 M src/services/billingDraftIntegrity.js
 M src/services/billingDraftMetadata.js
 M src/services/billingReview.js
 M src/services/extraStoreEntitlements.js
 M src/services/paymentNotificationWorker.js
 M src/services/paymentTelegram.js
 M src/services/platformOrganization.js
 M src/services/promoCodes.js
 M src/services/storeTradingHolds.js
 M src/services/tenantRecovery.js
 M tests/customers-integration.test.mjs
 M tests/database-production.test.mjs
 M tests/databaseIntegration.test.mjs
 M tests/httpIntegration.test.mjs
 M tests/recoveryRowManifest.test.mjs
 M tests/storeTradingHolds.test.mjs
 M tests/suspensionMiddleware.test.mjs
 M tests/tenantIntegrityMigration.test.mjs
 M tests/transaction-contract.test.mjs
 M tests/workspaceRevision.test.mjs
?? docs/PRODUCTION_RELEASE_READINESS.md
?? docs/SUBSCRIPTION_BILLING.md
?? docs/ZENIX_AI.md
?? migrations/033_subscription_billing.sql
?? migrations/034_resource_entitlements.sql
?? migrations/035_zenix_ai.sql
?? scripts/inspectRelease.mjs
?? src/config/ai.js
?? src/config/subscriptions.js
?? src/lib/requestScope.js
?? src/routes/ai.js
?? src/routes/registers.js
?? src/services/aiChat.js
?? src/services/aiMaintenance.js
?? src/services/aiPolicy.js
?? src/services/aiProvider.js
?? src/services/aiQuota.js
?? src/services/aiReports.js
?? src/services/posRegisters.js
?? src/services/resourceLimits.js
?? src/services/subscriptions.js
?? tests/aiDatabase.test.mjs
?? tests/aiProvider.test.mjs
?? tests/aiSafety.test.mjs
?? tests/releaseIntegration.test.mjs
?? tests/releaseRecoveryDatabase.test.mjs
?? tests/releaseSafety.test.mjs
?? tests/resourceLimitErrors.test.mjs
?? tests/resourceLimitsDatabase.test.mjs
?? tests/resourceLimitsHttp.test.mjs
?? tests/subscriptionAccess.test.mjs
?? tests/subscriptionDatabase.test.mjs
?? tests/subscriptionHttp.test.mjs
?? tests/subscriptionMigration.test.mjs
?? tests/subscriptionPricing.test.mjs
?? tests/subscriptionReviewMessage.test.mjs
```

### frontend

```text
M design-baseline.json
 M scripts/test-frontend.mjs
 M src/App.jsx
 M src/context/AuthContext.jsx
 M src/context/StoreContext.jsx
 M src/layout/MainLayout.jsx
 M src/pages/billing/Billing.jsx
 M src/pages/register/Register.jsx
 M src/services/apiClient.js
 M src/styles/saas.scss
 M src/utils/license.js
 M tests/auditFixesFinal.test.mjs
 M tests/billingActivationNavigation.test.mjs
 M tests/billingCheckoutDraft.test.mjs
 M tests/billingReceiptError.test.mjs
 M tests/deepAudit.test.mjs
 M tests/expenseBranchScope.test.mjs
 M tests/fiftyThreeFixesRegression.test.mjs
 M tests/integrityHardening.test.mjs
 M tests/registrationChoices.test.mjs
 M tests/registrationOtpReact.test.mjs
 M tests/warehouses.test.mjs
?? src/components/SubscriptionPlans.jsx
?? src/pages/ai/ZenixAI.jsx
?? src/pages/ai/zenixAi.scss
?? src/utils/subscription.js
?? tests/aiBackend.test.mjs
?? tests/subscriptionBackend.test.mjs
?? tests/subscriptionPresentation.test.mjs
```
