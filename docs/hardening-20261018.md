# Platform hardening — 2026-10-18

Scope: first verified safety fixes against main (including merged AI PR #13).
Preserve design, pricing, existing data and deployment configuration.

Implementation plan:
- Reproduce refund replay accepting a changed payment split or shift; bind new refunds to the full validated request and retain legacy replay compatibility.
- Reproduce frontend losing financial retry identities after HTTP timeout/conflict; retain uncertain identities across refund, customer payment, checkout and receipt flows.
- Reproduce rejection of explicit hypothetical Uzbek advice; exempt only the conditional clause while preserving evidence, numerical and execution guards.
- Run targeted regressions, disposable PostgreSQL POS integration, broader suites and frontend build; record actual results and limits.
- Deliver separate reviewable PRs without merge, deployment or production migration.

Remaining platform audit: exhaustive browser/role/device matrix and comparable production latency measurements are outside these initial verified fixes. No claim of full platform acceptance.

## Findings and changes

- P1: refund replay checked product/quantity/method but ignored changed payment split, shift and metadata. New refunds store a server-computed full validated intent fingerprint. Legacy rows retain their existing replay behavior; no backfill or migration.
- P1 (frontend companion): HTTP 408/425/429 and unclassified 409 responses could release financial retry identity. Shared rejection classification now retains it for checkout, receiving, refunds and customer payments. Refunds persist the original full payload across refresh/date/shift changes, and incomplete success responses cannot acknowledge refunds.
- P2: evidence validation rejected explicit hypothetical Uzbek trends such as “Agar savdongiz kamaygan bo‘lsa”. Only that conditional clause is exempted; subsequent claims, numbers and execution claims still require validation.
- P2 QA: finance fixtures lacked an active subscription/register; cross-repository contracts referenced pre-refactor bootstrap/receipt code. Fixtures now satisfy actual guards and assertions follow the authoritative service.
- P2 QA: full migration catalogue takes roughly 25 seconds on this local Docker host, exceeding the integration test's 15-second override. Serialization now uses the unchanged runner default (120 seconds), with a separate test proving lock expiry prevents any schema access and releases the client.
- POS HTTP PostgreSQL integration now runs explicitly in backend CI instead of being skipped without TEST_DATABASE_URL.

## Verification

- Backend standalone final: 612 passed, 0 failed, 51 skipped (explicit database/environment gates).
- Frontend standalone final: 263 passed, 0 failed, 0 skipped.
- Frontend cross-repository final: 120 passed, 0 failed, 2 skipped (external browser acceptance).
- Disposable PostgreSQL POS + AI conversation: 33 passed, 0 failed, 0 skipped.
- Broader PostgreSQL run (catalog, migrations, auth/RBAC, subscription, resource limits, warehouse, finance, AI reports): initially 87 passed / 2 failed. Both failures investigated; corrected finance fixture passes and migration serialization passes individually. Original failed logs are retained in workspace .task/hardening-broad-db.log.
- Backend syntax: 153 modules passed. Frontend build, source audit, readiness and design checks passed; 23 CSS/SCSS baseline files unchanged.
- Read-only independent review: no remaining concrete findings after fixing immutable refund retries.

## Performance and limits

Existing synthetic budgets passed: 50k POS search P95 1.054 ms; 10-line cart against 50k map P95 0.049 ms; 10k analytics filter P95 0.575 ms. Main gzip 117,471 bytes; total JS gzip 422,715 bytes. These are local CPU/build results, not network or production latency. No comparable before measurement or production speed improvement is claimed.

No exhaustive live module/device/role audit, real barcode/printer exercise, 1k/10k/50k remote catalog network comparison, live OpenAI evaluation or production load test has been completed. Provider behavior in integration tests is controlled. These remain follow-up work; this delivery is a verified initial hardening increment.

## Release

No production data, configuration or infrastructure was changed. No new schema migration is required. Review and complete PR CI first; release the frontend immutable retry payload before enabling the stricter backend replay check. Validate retry/reconciliation in staging, then deploy only with explicit release authorization. Existing pending journals created by older clients cannot retroactively recover their original payload.

## Delivery state

- Frontend pushed: `hardening/platform-20261018`, commit `24b26f3`.
- Backend pushed: `hardening/refund-ai-bounds-20261018`.
- Draft PRs created after explicit user authorization to use existing Git authentication: frontend https://github.com/Wamwod10/Zenix-Pos/pull/22 and backend https://github.com/Wamwod10/Zenix-Pos-Backend/pull/14. The connector's initial HTTP 403 blocker was resolved through the authorized GitHub API fallback; credentials were never printed or stored in files.
- Hosted CI must complete before release; local test results above are distinct from hosted CI. Neither PR was merged or deployed.

Changed application files: backend `src/routes/sales.js`, `src/services/posReplay.js`, `src/services/aiAgentReply.js`; frontend `src/context/StoreContext.jsx`, `src/utils/checkoutAttempt.js`, `src/utils/refundAttempt.js`. Regression tests, the backend POS integration CI step and this report accompany them. No styles or production deployment settings changed.

## Continuation plan

Continue on the existing draft PR branches; do not merge or deploy. First verify the previous broad DB suite as a whole. Then reproduce remaining supplier-payment and expense retry hazards using isolated PostgreSQL HTTP tests, bind retries to actor and complete intent, use exact cents for supplier debt allocation, and persist frontend intent before dispatch. Verify malformed payment responses cannot clear journals. Preserve legacy clients and all existing business guards; any additive index migration is generated and tested locally only. Audit further module boundaries after this financial safety increment.

## Continuation results

The previous broad DB suite was rerun as requested: **89 passed, 0 failed, 0 skipped**. Its first invocation hit local Docker startup recovery; the accepting-connections state was verified before the successful run. No production database was used.

### Newly reproduced issues and fixes

| Priority | Reproduced issue | Fix and evidence |
|---|---|---|
| P1 | Identical supplier payment requests created distinct payment rows, doubled paid debt and could duplicate till outflow. | Atomic completed-result replay keyed by tenant/operation/reference, bound to actor and validated input; concurrent and lost-response HTTP retries now return the same row. |
| P1 | Expense creation retries created distinct expenses and cash movements. | Same transactional replay cache; original result survives later expense deletion, so retry cannot recreate a deliberately deleted expense. |
| P1 | A 0.11 payment against 0.10 supplier debt was accepted because of a one-cent tolerance. | Integer-cent allocation via existing sumMoney; any remainder is rejected and all partial allocations roll back. Sub-cent input is rejected. |
| P1 | Customer payment accepted an incomplete success and discarded its retry identity. | Validate the financial result before acknowledgement; retain exact payload and restore pending collection even when refreshed debt is zero. |
| P1 | Concurrent tabs could create different references, or a rejection in one tab could erase another tab's uncertain committed reference. | Atomic Web Locks preparation, persisted shared state, live settlement checks and reference-conditional acknowledgement. Late results cannot erase a newer journal. Applied to supplier/expense and existing refund/customer paths. |
| P1 | An uncertain expense response could delete an already uploaded receipt; retry uploaded another file. | Preserve the receipt while outcome is unknown and reuse its original key. Mounted UI test verifies no delete and one upload across retry. |
| P1 | Transfer receipt accepted 0.0004 and returned that value although numeric stock storage rounded to three decimals. | Receipt now uses the same precision/quantity cap as dispatch. Invalid requests leave the transfer dispatched; valid zero/0.125, duplicate receive rejection and tenant/branch isolation are verified. |

Supplier UI restores a pending payment despite zero remaining debt and blocks double-click dispatch. Expense forms restore unresolved creation packets. Existing pricing, design, stock business rules and legacy requests without references are preserved. Middleware/RBAC and subscription checks still run on every retry.

### Verification of final continuation code

| Check | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Backend standalone | 612 | 0 | 53 |
| Frontend standalone | 269 | 0 | 0 |
| Cross-repository contracts | 120 | 0 | 2 |
| Combined disposable PostgreSQL integration | 129 | 0 | 0 |

The 129-test run combines the previous broad suite, POS/refund/credit, new financial write replay, transfer receiving and AI conversation/evidence/action confirmation tests. The new database files are skipped in standalone runs without an explicit test URL and run explicitly in backend CI. Three source/schema snapshot failures caused by the new schema/money parser were updated to assert the new contracts without removing their original protections. Final backend syntax covers 154 modules. Frontend build, source audit and 23-file CSS/SCSS design baseline pass. An additional receipt upload/retry interaction passed after the full suite. Independent read-only review identified the shared-journal races above; both were corrected and re-reviewed with no remaining concrete finding.

### Coverage and remaining audit

| Area | Evidence from this continuation | Remaining |
|---|---|---|
| POS, sales/refund, customer debt | Real local HTTP/PG replay, cash/card/credit, concurrency, exact refunds; mounted pending/refresh/branch tests | Physical tills, printers and scanners |
| Suppliers, expenses/finance | New replay/rounding/receipt/zero-debt UI tests; finance date/refund/3000+ pagination integration | Exhaustive purchase/invoice editor and financial-report browser matrix |
| Inventory, warehouses and transfers | Warehouse partition/count/stock locking integration; new exact receive and scope HTTP test | Full variant/serial/expiry UI workflows and all transfer buttons |
| Products/categories, dashboard/analytics | Existing full frontend contracts and large-catalog DB checks; report period/comparison tests | Exhaustive CRUD/filter/device walkthrough |
| Employees/RBAC, authentication/sessions, billing/subscriptions, Super Admin | Previous broad DB suite fully revalidated; role/resource/subscription/tenant boundaries and directory tests; selected users/settings route review | Full live screen/button/session matrix |
| Settings | Selected branch/role authorization source review and existing source/interaction contracts | Complete workspace settings CRUD across roles |
| ZENIX AI | Existing actual local PG conversation, report scope, evidence, repair, quota and explicit action confirmation tests remain green | Live OpenAI responses and real provider latency; no new AI behavior claimed in this continuation |

This is continued, verified hardening, **not an assertion that all platform screens, roles and devices have been audited**. Synthetic provider tests do not establish live model answer quality. Browser/device/hosting acceptance and comprehensive performance measurements remain open.

### Performance and release update

No performance algorithm optimization was introduced. Existing local synthetic budgets passed under concurrent test load: 50k search P95 3.375 ms, 10-line cart/50k map P95 0.721 ms, 10k analytics P95 1.315 ms. These conditions differ from the earlier 1.054 ms result, so no speedup or like-for-like regression is claimed. Main bundle gzip is 117,899 bytes (+428); total JS gzip 423,808 bytes (+1,093), both below existing budgets.

**The continuation now requires additive migration `040_financial_write_replays.sql`.** Earlier “no migration required” statements describe the first package only. The migration creates one empty replay table with tenant/actor FK and primary key; it does not update/backfill existing business rows. It was applied and schema-verified only in disposable PostgreSQL. No production migration/deploy was performed.

Release remains gated: review hosted CI and validate staging; prepare migration040 through the authorized release process; make the new frontend immutable refund payload available **before** enabling backend strict refund replay. Supplier/expense replay guarantees require both corresponding frontend and backend versions; legacy clients omitting references remain compatible but cannot gain retry deduplication automatically. Do not drop replay records when deleting expenses; cached completion intentionally prevents resurrection. Replay retention and journals on browsers without Web Locks need a separately evaluated policy. Unknown outcomes must be reconciled, not silently discarded.

Continuation application files: backend `src/services/financialWriteReplay.js`, `src/routes/suppliers.js`, `src/routes/expenses.js`, `src/routes/inventory.js`, `src/db/verifySchema.js`, migration040 and CI; frontend `src/utils/checkoutAttempt.js`, `src/utils/refundAttempt.js`, `src/context/StoreContext.jsx`, and supplier/expense/customer/sales/history pages. Focused tests accompany each changed flow. Both original draft PRs are retained; neither is merged.
