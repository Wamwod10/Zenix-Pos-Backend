# Phase 1 review and release — 2026-10-20

Base: backend `622787695f533f866eb7ff698011d0b33213ffef`, frontend `c5db7c6` (fresh GitHub main fetch). Branch in each repo: `phase1/professional-finish`.

Readiness follow-up: see [PHASE1_READINESS.md](PHASE1_READINESS.md) for the subsequent real-environment inspection, corrected fixture/AI regression results, current blockers and the concrete three-stage worker rollout. That report supersedes the original baseline-failure and release notes below where they differ.

## Changes

- All 13 business Telegram templates share `ZENIX POS BOT`, separator, escaped/bounded Unicode fields and grouped UZS amounts. Cash differences include an explicit positive sign. Sale line count and sold quantities by actual unit are separate; legacy queued payloads still render.
- Payment decisions retain business, owner/phone, quote, period, limit, amount, order and submission time. Initial server-derived display details are checkpointed in the existing outbox, so later business/profile changes do not rewrite the sent details. Decision status, actor, time and rejection reason accompany them.
- Existing organization-first/payment-row locks and conditional status update still own financial once-only behavior. The final Telegram edit is enqueued in that same transaction. Telegram failure never reverses a financial decision.
- Photo/PDF reviews retain media. Overflow uses a full text reply, keeps order/status on the receipt caption, removes buttons, and checkpoints the reply ID so caption-edit retries reuse it. Successful repeated edits are harmless. Final edits are asynchronous, normally on the next 15-second worker cycle.
- Message kind/ID persistence is atomic. Callback message type overrides stale metadata for matching IDs. An initial send racing a platform decision reconciles the final status/actor from committed payment/audit data.
- Scheduled totals use sales on the selected day minus returns on their processing day; actual refund cash/card/transfer breakdown is deducted. Credit remains in net sales, outside collected cash/card/transfer. Labels distinguish net sales from net payment receipts.
- Scheduled reports are explicitly interim; closing reports are explicitly final. A closed branch does not receive a later scheduled snapshot. Existing unique outbox keys prevent repeated enqueueing.
- Inventory receipt was already connected transactionally on main; an HTTP concurrency test now asserts exactly one `inventory.received` event after repeated receipt submission.
- Frontend: Dashboard uses actual product units; Telegram saves are serialized, patch only the changed setting, and visibly report success/failure with rollback. Existing styles preserved.

## Verification evidence

These counts are separate runs, not an additive total:

| Check | Result |
| --- | --- |
| Final targeted Telegram/payment/report tests | PASS 44, FAIL 0, SKIP 0 |
| Final standard backend suite without DB flags | PASS 628, FAIL 0, SKIP 54 (DB-gated; separate DB runs below) |
| Final real PostgreSQL payment concurrency + scheduled refund accounting | PASS 2, FAIL 0, SKIP 0 |
| Real PostgreSQL DB/HTTP regression batch | PASS 62, FAIL 0, SKIP 0 |
| Final POS HTTP/refund/credit/receipt replay tests | PASS 11, FAIL 0, SKIP 0 |
| Frontend combined regression | PASS 391, FAIL 0, SKIP 2 (environment-dependent browser tests subsequently run below) |
| Chromium subscription regression, both current versions | PASS 7, FAIL 0, SKIP 0 |
| Old frontend/new backend compatibility, Chromium + HTTP + PG | PASS 7, FAIL 0, SKIP 0 |
| New frontend/old backend compatibility, Chromium + HTTP + PG | PASS 7, FAIL 0, SKIP 0 |
| Targeted Chromium UI: units, serialized saves, rollback/error, 390px viewport | PASS; no horizontal overflow or browser errors |
| Vite production build | PASS |
| Existing design baseline | PASS: 23 CSS/SCSS files unchanged |
| Backend syntax | PASS: 155 JS modules |
| Broad backend regression with local PG/AI flags | PASS 776, FAIL 8, SKIP 10 |
| AI Chromium regression | PASS 3, FAIL 3 (two failing child scenarios and their parent); reproduced unchanged on main |

Broad backend failures reproduced on unchanged main (8/8): `prompt3Performance.test.mjs`, `saasDatabaseIntegration.test.mjs`, `saleTrackingSelections.test.mjs` have fixtures rejected as business read-only; five `warehouseMigrationAudit.test.mjs` cases fail the existing migration-catalog preflight. No production business guards were weakened to make fixtures pass.

The ten broad-suite skips are existing environment-gated migration/recovery/subscription/resource/release integrations, not new skips or PASS claims. GitHub CI has dedicated jobs for several of these. The payment concurrency test now runs in the existing DB CI job; scheduled financial accounting is added to its existing POS CI job. CI status must be reviewed separately on both PRs.

Detailed local logs are under workspace `artifacts/phase1-*.log`; mobile screenshot: `artifacts/phase1/telegram-mobile.png`. No live Telegram send or real payment approval was performed. All database writes/migrations during verification targeted disposable loopback PostgreSQL databases.

## Migration and compatibility

No new migration or dependency. Uses existing billing/audit/outbox tables and JSON payloads. No historical financial rows are rewritten. Frontend API request/response contracts remain compatible; partial Telegram settings PATCH already exists in baseline backend. Compatibility tests cover subscription/authenticated UI flows, not every possible API combination.

## Approval-gated release order

1. Review both PRs, CI evidence and the baseline failures above. Resolve or explicitly accept existing regression failures before production acceptance. Complete isolated live Telegram acceptance below.
2. Obtain owner approval for the production release. No merge, production deploy, settings change or Neon migration has been performed by this task.
3. During the approved backend maintenance window, quiesce all old notification consumers, including embedded `src/server.js` workers and any standalone `src/worker.js`. Drain in-flight work gracefully. Deploy API and workers from the same reviewed backend commit; verify no old consumer remains before resuming reviews. Old business workers do not recognize the new billing-only final-edit event exclusion, so mixed old/new consumer overlap must be avoided.
4. Verify worker health and inspect billing outbox statuses read-only. Confirm one test approval/rejection, preserved receipt and no customer-group billing messages. No SQL migration is part of this release.
5. Deploy the reviewed frontend commit. Check Dashboard units, Telegram test/save/error states and mobile layout. Existing CSS baseline must remain intact.
6. Observe failed/retry outbox rows and audit records. Obtain final owner acceptance.

Rollback: revert frontend independently. Before backend rollback, stop consumers and finish or quarantine pending `billing.payment_review_updated` work under an approved operational procedure; keep a compatible new worker until it is drained. Do not let an old general worker consume those events. Restore the previous application release only after queue safety is verified. No down migration, data deletion or reversal of approved payment records is required or authorized.

## Live Telegram acceptance (isolated test business/bots only)

1. Link a test group, send the branded connection test, toggle each notification setting and verify tenant/branch routing with another test business/branch.
2. Trigger all 13 events using test data. Include fractional kg/litre sales, mixed payments, credit and cash/card/transfer refunds on a later business date. Compare reports against database test fixtures/accounting, including a day containing only refunds.
3. Test shift close with positive, negative and zero cash difference. Verify `+231 000 so‘m`/`-231 000 so‘m` and actual units.
4. Submit independent photo and PDF test receipts. Save their original details. Approve one and reject another; verify complete details, receipt, actor, timestamps and removed buttons. Repeat callback and press simultaneously from two allowed test admins; assert one financial decision/audit/final event.
5. Use long names/reasons and `<`, `>`, `&`, emoji; verify valid HTML and overflow reply. Simulate a temporary Telegram transport/caption error in staging; verify retry reuses the checkpointed reply, with finance unchanged.
6. Receive inventory twice with the same client reference; verify one stock receipt/outbox event. Trigger scheduled interim reporting then close the day; verify clear labels and no unlabelled duplicate. Close before report time; verify no later scheduled branch snapshot.

## Remaining risks / release blockers

- Existing baseline regression failures and live Telegram acceptance remain open. This is a review candidate, not an unconditional production acceptance.
- Telegram offers no idempotency key for `sendMessage`/media sends: if Telegram accepts a send but its response or the subsequent database checkpoint is lost, a retry can duplicate a notification/reply. Financial review remains database-idempotent. Confirmed reply checkpoints avoid ordinary caption retry duplication.
- Very long free-text values are bounded with an ellipsis for Telegram; full original records remain in the database. Existing legacy messages without a persisted initial snapshot use trusted current server context.
- Deleted/uneditable Telegram messages eventually leave an observable failed outbox event after eight attempts; manual staging/operations review is required. Do not replay the financial review to repair a display problem.
- Mixed-version worker rollout/rollback requires the quiescence procedure above.

Next owner decision: approve review/isolated Telegram acceptance, then explicitly authorize the maintenance-window backend release followed by frontend. Do not merge/deploy automatically.
