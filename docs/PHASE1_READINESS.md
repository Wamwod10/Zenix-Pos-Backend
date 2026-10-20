# Phase 1 Telegram acceptance and release readiness — 2026-10-20

Continuation of existing frontend PR #23 and backend PR #15, both on `phase1/professional-finish`. No merge, production deploy, production migration, webhook change, real-business write or real-customer payment decision was performed.

## Real Telegram result: NOT RUN

The one existing enabled database connection is **Zenix pos payment**. No group was created or requested. Production was queried read-only for its connection metadata, not customer payment/sale contents. The schema stores the chat/tenant/branch association; it does not store bot tokens or webhook secrets. Application code loads both bot tokens and the admin allowlist from environment variables.

No local bot credentials were present. The Render connector provides no environment-secret getter; no Render/Neon CLI authentication was available. The owner confirmed that credentials cannot currently be provided and instructed us to finish the other checks. Therefore:

| Acceptance item | Result |
| --- | --- |
| Real Telegram delivery for each of the 13 business event types | NOT RUN — credentials unavailable |
| Both bots' membership/send permission in the existing group | NOT VERIFIED — credentials unavailable |
| Live photo/PDF approval and rejection | NOT RUN — no isolated live callback route/credentials |
| Live callback double-click and concurrent administrators | NOT RUN |
| Live Telegram edit retry, mobile Telegram rendering | NOT RUN |
| Local templates, media/caption API contract, callback concurrency/retry and accounting | Automated local/API-mock and isolated PostgreSQL coverage; see test evidence |

These items are not mock-derived live PASS claims. Actual test payments must exist only in an isolated test database. A production bot's webhook must never be repointed, deleted or polled via `getUpdates` to steal its updates for a test. Even with outbound credentials, full button acceptance requires an already isolated callback route/bot configuration in the same existing group.

When available, put test credentials in ignored `backend/.env.telegram-acceptance.local`, not chat, logs or Git. Required names: `TELEGRAM_BOT_TOKEN`, `ZENIX_PAYMENT_BOT_TOKEN`, `ZENIX_PAYMENT_ADMIN_USER_IDS`; resolve the one existing chat ID from the verified connection. Keep `NODE_ENV=test`, `RUN_NOTIFICATION_WORKERS=false`, and an explicit loopback database whose name contains `test`. Use a separate local callback secret. Test tooling must explicitly allowlist that one chat and synthetic records; do not load the production database URL or start `src/server.js`, which configures webhooks at startup.

## Corrections made during readiness review

1. `prompt3Performance.test.mjs` and `saleTrackingSelections.test.mjs` created organizations without a writable license, then attempted business writes. Their fixtures now have an active finite test license. Subscription guards are unchanged.
2. `saasDatabaseIntegration.test.mjs` tried to create its initial owner after placing the business on billing hold. The owner is now created first, then the hold is enabled before testing free-promo activation. The held-state redemption and one-use/reset assertions remain.
3. `frontend/tests/aiBackend.test.mjs` used a hidden legacy suggestion selector and injected the old report-provider protocol while the UI sent `conversationId`. The adapter now uses the current agent/tool protocol, authentic token-cost calculation and real report SQL; the test types a question, asserts successful HTTP response, rendered database amount and persisted quota. No frontend AI product behavior changed.
4. With that test fixed, an existing backend issue became observable: an unknown/foreign requested branch reached conversation/quota processing, yielding a generic failure or provider dispatch. `aiAgentChat.js` now uses the existing organization-store assertion during initial actor authorization, before quota reservation. The HTTP regression proves 404 for foreign and absent branches, zero provider dispatch and no `ai_requests` reservation. This was present before Phase 1; the small correction strengthens existing isolation without adding AI functionality.
5. The three corrected database fixtures are now included in the existing disposable-PG POS CI step, rather than silently remaining gated out of standard unit CI.

Independent read-only code review found no critical/important defects in these changes. The new branch check uses `activeOnly:false` to preserve historical reporting for an inactive but owned branch.

## Current local verification

Counts below are independent runs, not an additive total. Full logs are workspace artifacts, not production logs.

| Check | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| Full frontend combined suite including both real browser/HTTP/PG integrations | 404 | 0 | 0 |
| AI browser subset (real local HTTP/PG, deterministic paid-provider boundary) | 6 | 0 | 0 |
| AI agent conversation + HTTP isolation subset | 23 | 0 | 0 |
| Three repaired DB fixture files including tracking unit cases | 8 | 0 | 0 |
| Standard backend without database flags | 628 | 0 | 54 |
| Broad backend with local test DB and AI flags | 783 | 5 | 10 |

The five remaining broad failures are listed below; the ten broad skips are the existing separately gated migration/recovery/subscription/resource/release scenarios. None was converted to a skip by this work. Standard-suite 54 skips require database/environment flags; use the broader and dedicated CI jobs to assess those integrations. Backend syntax: 155 modules PASS. No frontend product/CSS change was made during this follow-up.

Telegram template/media/callback/retry assertions pass in the standard/broad runs, but these use a mocked Telegram boundary. Financial assertions execute real local PostgreSQL SQL. For example, the mixed/credit fixture asserts net sales 280,000, cash 20,000, card 130,000 and transfer zero; the later refund-day fixture asserts net sales -75,000, cash -35,000, card -10,000 and transfer zero. The remaining 30,000 is credit reduction, not cash/card paid out. Positive/negative/zero cash-difference template assertions also pass. These are synthetic fixtures, not customer balances.

Both existing PRs were initially verified open, draft and mergeable with successful GitHub workflows on their then-current heads. Follow-up commits update those same PRs; final CI and mergeability must be assessed on the new exact heads, separately from local evidence.

## Remaining historical warehouse tests

Five `warehouseMigrationAudit.test.mjs` cases still fail. They create a historical 001–030 database and ask the current strict auditor to accept only 031/032 as pending. The current catalog also contains 033–040; the auditor correctly refuses that state. Subsequent current-schema verification also requires a version-aware historical fixture design.

- Phase 1 cause: no; reproduced on unchanged main.
- Production implication: a historical migration rehearsal/coverage gap, not evidence of a failing Phase 1 runtime operation. The fail-closed audit is protective and must not be weakened to get green tests.
- Disposition: separate version-pinned historical migration-test task. Block any 031/032 migration rollout until repaired. Phase 1 adds no SQL migration, so these five failures alone do not establish a runtime-release blocker; they remain explicitly reported and require owner acknowledgement.
- Real Telegram acceptance, a fresh backup gate and the worker rollout gates below still prevent an unconditional production-ready claim.

## Verified infrastructure (read-only)

Render workspace: owner-confirmed **My Workspace** (`tea-d2sr84be5dus73f1mf9g`).

- Production API: `srv-darqr0l9fdbs73amtig0`, one instance, `npm run start`, manual deploy/auto-deploy off, live commit `622787695f533f866eb7ff698011d0b33213ffef` (deploy `dep-dbaaeorrjlhs739h8ca0`). No separate Zenix background-worker service was listed in this workspace.
- This production commit's `src/server.js` starts both notification workers unless `RUN_NOTIFICATION_WORKERS=false`. Thus embedded workers must be considered during any rolling deploy. The actual live flag value could not be read with the available connector; it must be checked by the operator before release.
- Staging API: `srv-db733fpsrm7s73bs1bqg`, auto-deploy off, old commit `20ce0456500671f612d47d409b6ddf9edacfedc4`. Its custom startup imports `app.js`, applies a staging access header and pins `ep-purple-wind-b1p90nsa` (direct/pooler); it does not start these workers or register webhooks. The current project's endpoint inventory does not contain that pinned host, and no staging-labelled branch appears in branch inventory. Staging needs an explicitly approved isolated database binding/current artifact before it can be used; do not substitute the production endpoint.

The production endpoint inventory belongs to the confirmed production branch. No connection string or database password was requested or exposed.
- Production payment-review outbox aggregate: eight initial review events were `sent`, no final-edit events present at inspection. This describes the queue then; it does not prove media formatting or live callback success.

Neon project `steep-wind-39440568`, production branch `br-wild-credit-b14yvhes`:

- Most recent listed manual snapshot: `snap-plain-dust-b1ivmjhv`, `zenix-pre-hardening-040-release-20261018`, created `2026-10-18T10:55:32Z`.
- Automatic snapshot schedule: empty. Configured PITR history retention: 86400 seconds (24 hours).
- Historical branch metadata records prior snapshot restores on October 10/13. Metadata alone does not prove that the latest snapshot restores to a correct current application/ledger state.
- No new snapshot, branch restore or production SQL write was executed. A fresh, owner-authorized pre-release backup and restore-validation gate is still required. Do not restore over production as a rehearsal; use an isolated destination and keep copied customer data out of Telegram.

## Concrete worker-safe release plan — approval required

Render normally starts the new instance before terminating the old instance; one configured instance does not mean no overlap. A restart uses the running configuration and does not apply newly saved environment variables. See [Render deploy documentation](https://render.com/docs/deploys).

All of the following are proposed operations, not actions performed by this task:

1. Capture current API/frontend artifact IDs and preserve existing environment settings. Obtain explicit release and temporary notification-pause approval. Confirm no external/standalone/one-off Zenix consumer exists. Verify the current production commit honors `RUN_NOTIFICATION_WORKERS=false` (confirmed in repository source).
2. Set only `RUN_NOTIFICATION_WORKERS=false` using the operator's existing secret configuration, then **deploy the current production commit `6227876`**, not the new branch. Wait for the new worker-disabled API to be live and all previous API/worker processes to exit. Confirm shutdown/in-flight work has drained; the application's own shutdown deadline is 10 seconds and a Telegram call can take 15 seconds, so an interrupted ambiguous send must be treated as an outbox/retry risk. Do not proceed if termination cannot be proven.
3. Deploy the reviewed new backend SHA with workers still disabled. Wait until every old-code process has exited. HTTP can enqueue new events but no old consumer may claim them. Keep callbacks pointed at the same production API; do not reset webhook secrets or replace bot config with test config.
4. Deploy the **same new backend SHA** with workers enabled. Only new-version workers now run; any overlapping prior instance has workers disabled. Confirm only one expected consumer set and inspect queue backlog/retry/failure aggregates. Do not substitute a plain Restart for the required configuration deploys.
5. Perform read-only production smoke checks: health/startup, owner/cashier authentication, branch-scoped reads, Dashboard/report formatting, Telegram settings reads, existing audit/payment history visibility. Any synthetic write or payment-button smoke belongs in the isolated test database and existing test group, not real customer records.
6. Deploy the reviewed frontend artifact, verify login and mobile layout, then monitor queue/HTTP error rates. No database migration is part of Phase 1. Owner supplies final acceptance.

Stop immediately if the active commit/worker flag is uncertain, an old process remains, failed final-edit events appear or queue destinations are unclear.

Rollback: frontend can return to its captured prior artifact independently. For backend rollback, first prevent new billing reviews during the approved maintenance window, pause workers on the new commit and prove old/new workers have stopped. Finish pending final-edit events with compatible reviewed code and verify no final-event retry/processing work remains before restoring the old consumer. If this cannot be verified, keep workers paused and fix forward; do not allow baseline's general worker to consume `billing.payment_review_updated`. Restore application artifacts only; never delete outbox/audit rows or undo approved finance to repair a Telegram display. No down migration is needed.

## Residual risks and next owner action

- Real Telegram: unverified until the credentials/isolated callback path are available; all tests must use the existing one group.
- Telegram has no send idempotency key. If a remote send succeeds but its response/checkpoint is lost, retry can duplicate a message. Database finance remains once-only; checkpointed successful replies avoid ordinary edit-retry duplication.
- Caption/text API behavior is locally covered but has not been accepted against actual Telegram here. Deleted/uneditable messages can exhaust retries and require display-only repair; never replay the financial decision.
- Five historical migration tests remain FAIL; environment-gated tests must retain their explicit SKIP status in broad-suite results.
- Production snapshot/restore freshness and runtime env flag need operator verification.

Next owner action: provide the two bot credentials/admin allowlist through the ignored local test file when available, then authorize a single-group isolated live acceptance session. Production merge, snapshot creation, configuration changes and the staged rollout remain separate approvals. No new group is required.
