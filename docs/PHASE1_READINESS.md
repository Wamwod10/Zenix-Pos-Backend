# Phase 1 Telegram acceptance and release readiness — 2026-10-20

## Final verification follow-up — 2026-10-21: BLOCKED

This section supersedes earlier counts where noted. No production write, deploy, merge, webhook change or worker configuration change was made.

- Fixed the remaining display inconsistency: all 13 business templates now separate fields with blank lines, matching the payment layout. The added assertion failed before the formatter change and passed afterward. Source business values, outbox payloads and financial calculations are unchanged.
- Fresh real Telegram run: **13/13 business templates PASS**, sent only synthetic TEST data to the existing **Zenix pos payment** group. Evidence: `artifacts/phase1-final-telegram.json`. This checks real API HTML parsing/entities and delivery, not mobile visual acceptance or business-operation-to-outbox wiring.
- The prior 28-request real photo/PDF/edit acceptance and two polished payment previews remain separate evidence; they were not replaced by these 13 business sends. Actual Telegram-delivered human callbacks remain **NOT RUN** because both existing bot webhooks serve production. Local concurrent/repeated handler tests are not claimed as delivered callbacks.
- Targeted formatter/payment/media/retry/report tests: **19 PASS, 0 FAIL, 0 SKIP** after the spacing correction. Standard backend before this spacing-only correction: **629 PASS, 0 FAIL, 54 environment-gated SKIP**. Backend syntax: **155 modules PASS**.
- Fresh broad backend with loopback PostgreSQL and AI flags: **784 PASS, 5 FAIL, 10 SKIP** (799 total). All five failures are the same historical `warehouseMigrationAudit.test.mjs` 031/032 catalog failures described below; no auditor requirement or assertion was weakened. Log: `artifacts/phase1-final-broad.log`. The ten skips still require their separately gated environments; the exact-head CI's dedicated billing/resource/recovery jobs cover those paths separately.
- Fresh frontend standalone: **271 PASS, 0 FAIL, 0 SKIP**. Full combined browser/HTTP/PostgreSQL run using installed Chrome: **404 PASS, 0 FAIL, 0 SKIP**. The first combined attempt had **391 PASS, 2 FAIL** because Playwright's default executable was absent; no product/test assertion was changed, and the rerun explicitly used installed Chrome.
- Frontend production build **PASS** (Vite emitted a plugin timing warning). Design baseline **PASS**, 23 CSS/SCSS files. Dedicated browser scenario **PASS** for actual units, serialized settings saves, failure rollback and 390px overflow; external requests were blocked. This does not certify the Telegram mobile application.
- Full two-version deployed compatibility matrix (old frontend/new backend and new frontend/old backend): **NOT RUN** in this follow-up. Existing API/contract tests and unchanged routes support compatibility but do not replace running that matrix in isolated environments.
- Frontend PR #23 (`06ababd`) and backend PR #15 (`1bbf36b` before this follow-up) were open, draft, mergeable and unmerged. Exact-head GitHub runs **39441632438 / 39468023012 SUCCESS**. Backend CI steps also passed POS/refund/tenant isolation, billing/resource tests and disposable-database backup/restore. Latest follow-up head CI must be checked separately.

Read-only infrastructure recheck: Render production remains `622787695f533f866eb7ff698011d0b33213ffef`, deploy `dep-dbaaeorrjlhs739h8ca0`, one API instance, `npm run start`, auto-deploy off, no separate Zenix worker service listed. Runtime `RUN_NOTIFICATION_WORKERS` value and all old process exits still require operator verification; repository startup embeds both notification workers unless that flag is false.

Neon production latest listed snapshot remains `snap-plain-dust-b1ivmjhv`, **2026-10-18 15:55:32 Asia/Tashkent**. Automatic snapshot schedule is empty; configured PITR window is **24 hours**. Restoring that old snapshot can lose every later write; metadata is not a successful restore drill. A fresh pre-release snapshot and isolated restore verification are required. No snapshot or restored branch was created here.

Backup gate, after explicit authorization: create a fresh snapshot of `br-wild-credit-b14yvhes`; record its timestamp/LSN; restore onto a **new isolated branch**, never an existing production target. Keep API/workers/webhooks disabled there. Verify schema, tenant constraints, financial/stock audit and representative read-only totals against a consistent snapshot-time source. Preserve evidence and restrict copied customer data; never send it to Telegram. Existing `verifyRestoreDrill.mjs` accepts independent offline **local** test copies only; it cannot certify the Neon restore by itself. The documented provider procedure was checked at [Neon backup & restore](https://neon.com/docs/guides/backup-restore).

Release remains **BLOCKED** pending fresh backup/restore evidence, actual human callback acceptance through a safe isolated arrangement in the same group, phone visual acceptance, the two-version compatibility matrix, and operator confirmation of worker/process gates. Historical 031/032 failures retain their separate disposition below; they must not be hidden or made green by relaxing the auditor. No Phase 1 SQL migration is needed.

Approved rollout must follow the worker-disabled old SHA → worker-disabled reviewed SHA → same reviewed SHA with workers enabled → frontend sequence below. Stop on any uncertain flag/process, unexpected destination, financial mismatch or final-edit failure. **Rollback must use the captured worker-disabled old-code artifact**, not the original worker-enabled deploy: Render restores the target deploy's environment variables. Drain final-edit events with compatible new code before enabling an old consumer; otherwise keep workers paused and fix forward. Reverting code never reverses financial decisions. See [Render deploys](https://render.com/docs/deploys), [rollbacks](https://render.com/docs/rollbacks) and [health checks](https://render.com/docs/health-checks). Current Render health probing is TCP; an open port alone does not prove DB/queue readiness.

Continuation of existing frontend PR #23 and backend PR #15, both on `phase1/professional-finish`. No merge, production deploy, production migration, webhook change, real-business write or real-customer payment decision was performed.

## Real Telegram API result: PASS; delivered callbacks still unverified

The one existing enabled database connection is **Zenix pos payment**. No group was created or requested. Production was queried read-only for its connection metadata, not customer payment/sale contents. The schema stores the chat/tenant/branch association; it does not store bot tokens or webhook secrets. Application code loads both bot tokens and the admin allowlist from environment variables.

Initially no local credentials were available. The owner subsequently supplied them in `.env.example`. The exact supplied file was preserved in ignored `.env.provided-phase1.local`, the tracked example was restored, and an ignored `.env.telegram-acceptance.local` was created with only the required tokens/admin allowlist, the existing single chat, new local callback secrets and an explicit loopback test database. The supplied production database URL was not used. No secret values were printed, committed or sent to any destination except normal authentication to the Telegram API.

Read-only `getMe`, `getChat`, `getChatMember` and `getWebhookInfo` verified **zenixposbot** and **zenixpaymentbot** as administrators in **Zenix pos payment**. Both bot webhooks point to the production API. They were not modified or polled.

Controlled live API run `TEST-1792508218891`: **28 successful send/edit requests, zero API failures**. Only synthetic data from a newly created local test organization was sent. Evidence: workspace `artifacts/phase1-real-telegram.json`; the local harness is ignored under `.cache/phase1-real-telegram.mjs` and is not a production worker.

| Acceptance item | Result |
| --- | --- |
| Real Telegram delivery for each of the 13 business event types | PASS — all 13 formatted templates accepted by the real API in the existing group |
| Both bots' membership/send permission in the existing group | PASS — both administrator members and actual sends succeeded |
| Cash differences / report variants | PASS — positive, negative, zero; interim and final; 16 business messages total |
| Real photo/PDF send and final decision edit | PASS — 5 synthetic payments: PNG approval/rejection, PDF approval/rejection, long initial details and long rejection reason |
| Media and keyboard preservation | PASS — actual edit responses retained photo/document and had no decision buttons; long initial text and final caption overflow used text replies |
| Concurrent/repeated financial callbacks | PASS locally with real PostgreSQL — two synthetic concurrent handler calls and a later repeat for each case yielded one financial decision/audit each |
| Telegram-delivered button callback and simultaneous human admins | NOT RUN — existing webhooks remain production-bound; callbacks above were explicitly synthetic local handler invocations |
| Edit retry | PASS for locally injected transport interruption before a real edit request; retry completed through real API with finance unchanged. An actual Telegram outage/ambiguous remote acceptance was not induced |
| Mobile Telegram rendering / human visual acceptance | NOT VERIFIED — successful Telegram API/entity parsing does not certify phone layout |
| Business-event-to-outbox wiring during this live run | Not exercised by live business sends, which called the formatter/API directly; separate isolated integration tests cover event/outbox wiring |

The financial decisions used the actual review service and outbox final-edit service against local PostgreSQL, but the callback delivery boundary was simulated and `answerCallbackQuery` was not called with fabricated Telegram IDs. Actual test payments exist only in the isolated test database. A production bot's webhook must never be repointed, deleted or polled via `getUpdates` to steal its updates for a test. Full human-button acceptance still requires an isolated callback route/bot configuration in the same existing group.

The live accounting fixture had cash/card/mixed/credit sales totaling 380,000 and a 25,000 cash refund. Real scheduled-summary SQL returned net sales **355,000**, cash **95,000**, card **130,000**, transfer **0**, net receipts **225,000** and credit **130,000**. Those exact values were rendered into the real interim/final Telegram messages. No production financial records were read for this test or changed.

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

- Real Telegram send/media/edit API behavior passed in the one existing group. Human button delivery through an isolated callback path and phone visual acceptance remain unverified.
- Telegram has no send idempotency key. If a remote send succeeds but its response/checkpoint is lost, retry can duplicate a message. Database finance remains once-only; checkpointed successful replies avoid ordinary edit-retry duplication.
- Caption/text overflow, HTML special characters and media retention passed against actual Telegram. Deleted/uneditable messages can still exhaust retries and require display-only repair; never replay the financial decision.
- Five historical migration tests remain FAIL; environment-gated tests must retain their explicit SKIP status in broad-suite results.
- Production snapshot/restore freshness and runtime env flag need operator verification.

Next owner action: visually review the TEST messages/receipts in the existing group and confirm the phone layout. If human-button end-to-end acceptance is required, authorize an isolated callback arrangement in that same group without changing the current production webhooks. Production merge, snapshot creation, configuration changes and the staged rollout remain separate approvals. No new group is required.
