# POS Pro — Phase 2 backend

Base: Phase 1 `336d716`; branch `phase2/pos-pro`; PR base `phase1/professional-finish`. No migration or production configuration changes.

## Changes

- `src/routes/sales.js`: optional POS Pro metadata validation on the existing transactional checkout, stale catalog-price/unauthorized price-increase checks, existing configured credit-disable enforcement, and scoped `GET /api/sales/pos-pro/summary`.
- `src/services/posPro.js`: manual card/transfer confirmation and cash-tender validation; read-only current-shift sales/payment/refund/recent/popular aggregates from existing tables. No separate ledger or stock calculation.
- `src/services/saleHolds.js`: additive 500-line hold limit, preserving the same service/schema and tenant/user scoping.
- `tests/posPro.test.mjs`, `tests/posProHttp.test.mjs`: legacy-client compatibility, permission/branch rejection, manual confirmation, stale pricing, closed shift, replay, simultaneous cashiers, insufficient stock, split payment, ordinary sale visibility, shared audit/outbox, and refund-adjusted live totals.
- `scripts/benchmark-pos-pro.mjs`: safe loopback-only 10k/50k catalog benchmark; fixtures roll back.
- `.github/workflows/verify.yml`: include the new PostgreSQL HTTP test in the existing serialized POS test profile.

Old clients continue to use the existing sale API without the new optional metadata. POS Pro reuses existing authorization, license/store checks, shift locks, money/pricing validation, stock/tracking transactions, customer ledger, idempotency fingerprint, audit log and Telegram outbox. Its external payment flag records a cashier's manual confirmation, not bank authorization. No bank/fiscal provider is contacted.

## Evidence — 2026-10-21

- Targeted POS PostgreSQL/HTTP/catalog: **17 PASS, 0 FAIL**.
- Full serialized backend suite against disposable local PostgreSQL 18.4: **734 PASS, 5 FAIL, 17 SKIP / 756**. The five `warehouseMigrationAudit.test.mjs` failures (031/032 fixture migration-catalog assumptions) reproduce unchanged on Phase 1 `336d716` in a separate local database: **0 PASS, same 5 FAIL**. They are not POS Pro failures and have not been hidden or disabled.
- An initial concurrent full run had 15 failures because the existing migration test drops the shared test public schema. Serialized execution eliminates those extra failures.
- Syntax: **157 modules PASS**.
- Actual React browser → Express → PostgreSQL: ten simulated HID scans create one 120,000 UZS sale, cash 70,000/card 50,000; stock 20→10; one shared notification event; live shift summary and ordinary Sales remain consistent.
- Local catalog SQL/service p95 (12 samples): 10k page/search/barcode **22.38/25.29/12.76 ms**; 50k **13.55/57.45/17.37 ms**. These exclude internet/browser latency.

Run `NODE_ENV=test` with identical loopback `DATABASE_URL` and `TEST_DATABASE_URL`, then `node --test --test-concurrency=1 tests/posProHttp.test.mjs tests/posHttpIntegration.test.mjs tests/posCatalogDatabase.test.mjs`. `node scripts/benchmark-pos-pro.mjs` refuses non-test targets, including Neon. Run schema-recreating tests serially or in separate databases. Project CI remains on PostgreSQL 16 / Node 22.

Raw logs and JSON are under the parent workspace's `artifacts/phase2*`; the frontend `docs/POS_PRO.md` contains the complete feature, browser, performance, changed-file and hardware/release report. Physical devices and real terminal/fiscal provider operations remain untested. The Phase 1 Telegram worker release gate, explicit owner release permission and fresh production backup/restore check remain mandatory before release.

### Receipt UX regression follow-up (PR #16)

Only tests/posProHttp.test.mjs and this report change in this follow-up; backend business logic and migrations are unchanged. Added actual HTTP/PostgreSQL coverage for kg + l quantities, split cash/card allocations, cash tender/change and preserved canonical receipt data through idempotent replay and reconciliation. Ordinary sales history retains units; inventory and stored payments are asserted. Three targeted suites passed 18/18 (posProHttp, posHttpIntegration, posCatalogDatabase), using disposable loopback PostgreSQL 18.4. The frontend real browser -> Express -> PostgreSQL profile also passed normal kg split checkout and lost-response/reloaded l cash checkout with exactly two sales, correct stock/payments/change and existing Sales availability. Evidence: ../artifacts/phase2-ux-postgres.log and phase2-ux-real-browser.log. Existing historical 031/032 fixture failures remain documented above; they are not new failures or represented as passing. No production database, settings, deployment, Phase 1 branch or main merge was touched.

### Final supermarket QA (supersedes earlier open fixture status)

Full local PostgreSQL backend profile: 745 PASS, 0 FAIL, 17 optional-profile SKIP (762 total); targeted HTTP/PG/catalog/031-032/final-QA suites: 28 PASS, 0 FAIL/SKIP. Five historical warehouse tests now use a test-only catalog/schema contract pinned through 032 (requirements from 4c2f3a6); current production audit still rejects incomplete history. No auditor, migration or backend business service was relaxed. Added guarded localhost 100-product QA fixture and a worker-free localhost QA server, actual HTTP finance/credit/scope/shift checks, and CI execution of the new tests plus historical warehouse tests. Frontend corrected credit-cash reconciliation to use authoritative captured payments; its real browser profile closes the shift with zero difference. Both real Phase 1/Phase 2 checkout compatibility combinations pass. Full report and manual commands: https://github.com/Wamwod10/Zenix-Pos/blob/phase2/pos-pro/docs/POS_PRO_FINAL_QA.md . No deployment or production write.
