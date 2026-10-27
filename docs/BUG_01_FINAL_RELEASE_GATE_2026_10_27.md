# Final release gate — 2026-10-27

Decision: **NO-GO for production; changes are available for review.** No production write, migration, deployment, merge or historical correction was performed. Only localhost disposable PostgreSQL and newly isolated fixtures were mutated.

## Candidate and independent verification

Backend PR: https://github.com/Wamwod10/Zenix-Pos-Backend/pull/19 (`fix/branch-transfer-costing-20261027`). Frontend PR: https://github.com/Wamwod10/Zenix-Pos/pull/31 (`fix/transfer-create-retry-20261027`). Starting HEADs: backend `07a54fb4394b6483a51156bbe42180fec25b3fcf`, frontend `9fab2cb758c87528ffda02e8fb178a48030df2b7`.

Starting HEAD PR CI was successful: [backend 40543850576](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/40543850576), [frontend 40543166732](https://github.com/Wamwod10/Zenix-Pos/actions/runs/40543166732). These runs do not certify subsequent commits. Final HEAD CI must be checked separately.

## Confirmed hardening

Expected destination quantity overflow previously propagated PostgreSQL 22003 as HTTP 500. A locked-balance decimal/BigInt guard now rejects out-of-range addition with HTTP 409 `INVENTORY_NUMERIC_LIMIT` before mutation. It covers transfer receipt, dispatched cancellation restoration, inventory receipt and sale return. Negative balances remain rejected. Unknown cost and actual zero remain distinct.

The final boundary regression also reproduces silent cent loss at 90071992547409.91 when dividing an otherwise safe integer-cent value by 100. Conversion now builds the exact decimal string first and validates its JSON numeric round-trip; this value is rejected with FINANCIAL_PRECISION_REVIEW_REQUIRED instead of being rounded silently. Ordinary monetary rounding remains unchanged.

Financial integer-cent overflow now returns 409 `FINANCIAL_NUMERIC_LIMIT`. Invalid input prices are bounded consistently with existing payment limits (9,000,000,000,000), and quantity inputs retain their existing lower operational cap. This is an API input/representation limit, not a new accounting rounding policy. Generic/unrelated PostgreSQL 22003 errors still return 500; no global error-code remapping was added.

Catalog and finance NUMERIC values remain text inside PostgreSQL JSON until checked conversion to the existing numeric API shape. Unsafe decimal conversion returns 409 `FINANCIAL_PRECISION_REVIEW_REQUIRED`; it does not silently lose cents. Finance subtraction/addition uses decimal integer ratios, retaining fractional COGS rather than rounding every component to cents. Receipt weighted average is calculated in PostgreSQL NUMERIC using the locked balance; the existing positive-cost receipt input contract and its original assertions remain intact. Existing zero-cost stock can still transfer, sell and return without reference-price substitution. Creating a free receipt remains a pre-existing limitation and is not represented as fixed.

A real PostgreSQL supplier invoice test exposed DATE-to-JS-Date timezone serialization: the prior frontend calendar formatter correctly rejected a non-midnight instant but displayed a dash. Bootstrap now uses existing databaseDateISO on supplier due_date before JSON serialization, preserving the database calendar key for sorting and workspace formatting. This supplements BUG-04 without interpreting DATE as TIMESTAMPTZ. The regression first failed on real data and passed after the fix.

No new migration; immutable migrations `045_transfer_cost_snapshot.sql` and `046_transfer_create_replay.sql` are unchanged. No historical backfill.

## Results and reproducible evidence

Local environment: Windows, Node 24.11.1, npm 11.6.2; PostgreSQL localhost:55447 database `branch_costing_test_20261027`. Commands explicitly set NODE_ENV=test and local DATABASE_URL/TEST_DATABASE_URL; no production env was used. PowerShell npm.ps1 execution restriction was avoided with npm.cmd. Node subprocess EPERM required authorized execution outside the subprocess sandbox; it was not classified as a code failure.

| Gate | Result | Evidence / boundary |
|---|---|---|
| Backend npm test | PASS | 676 pass / 66 existing environment-gated skips after final cent-conversion fix; prior full local disposable-PG suite 823 pass / 17 skips; skips are not passes |
| Backend check | PASS | 166 JS modules |
| db:verify | PASS | 46 migrations, 64 tables, 190 indexes |
| migrate:status | PASS | No pending, missing, drifted or unknown migrations |
| db:audit-integrity | PASS | 0 violations |
| test:db | PASS | 60 tests |
| test:http | PASS | 2 tests |
| Frontend npm test | PASS | 316 tests; original assertions preserved |
| Frontend build/audit/design/production | PASS | Build succeeds; audit zero findings; 26 stylesheet baselines match; production script passes |
| NUMERIC boundary / rollback | PASS | `finalNumericSafety.test.mjs`, `branchTransferCostingHttp.test.mjs` |
| Browser Classic / Touch | PASS | `posProPostgres.browser.mjs`, both layouts, real Express + PG; checkout/retry/refresh/stock |
| Browser transfer timeout before request | PASS | `branchCosting.browser.mjs`, TEST_TRANSFER_TIMEOUT=before; abort before Express, reload, same reference, exactly one transfer |
| Browser timeout after commit | PASS | Same script, TEST_TRANSFER_TIMEOUT=1; drop committed response, reload/reconcile; exactly one transfer and dashboard destination valuation 2,000 |
| Browser partial/full return | PASS | Extended `frontendStockLifecyclePostgres.browser.mjs`: real product/receipt/sale/partial return/final return/shift; SQL and finance aggregate assertions at both stages |
| Browser cashier/manager flows | PASS | `posProSupermarket.browser.mjs`, 15 checks, 11 persisted sales; history and manager dashboard |
| BUG-02/03/04 synthetic browser regression | PASS, synthetic | `productionBrowserDashboard.browser.mjs`: later-day/other-operator refund ranking and supplier dates; not a PostgreSQL integration claim |
| Real supplier DATE / basic four-role browser | PASS | Real PostgreSQL invoice DATE displays 30.09.2026; OWNER/MANAGER/CASHIER/WAREHOUSE settings route and API/finance status assertions |
| Full requested browser matrix | NOT VERIFIED | Full four-role transaction/action matrix, cross-operator seller attribution and all report filter combinations remain incomplete |
| Staging production-like backup/restore | SKIP | No approved staging clone or production backup material provided; runbook required |

Local transcripts are under workspace `.task/final-*`; browser JSON/screenshots under `.task/final-browser`. They contain isolated fixture evidence and are not production audit screenshots.

## Financial and concurrency assertions

PostgreSQL NUMERIC independently asserts: dispatch snapshot 20,000 survives source repricing; destination `(10*5000+5*20000)/15=10000`, quantity 15 and valuation 150,000. Sale COGS 50,000 and full refund COGS reversal 50,000 net to zero revenue/profit. Return weighted average uses the original 10,000 sale snapshot after balance repricing.

Real browser two-unit sale: gross 24,000, first refund 12,000, reversed COGS 6,000, net revenue 12,000 and profit 6,000. Final refund: refunds 24,000, reversed COGS 12,000, net revenue/profit zero. Original one-unit fully refunded sale remains in the same fixture and contributes zero net. Stock returns to 10 and shift cash to opening 100,000 with zero discrepancy.

Parallel identical create requests yield one transfer/replay; changed payload or actor conflicts. Duplicate receipt yields one 200 and one 409. Opposite-direction two-product transfers with reversed request order complete; quantities return to 10, costs 12/18, with conserved combined valuation. Simultaneous sale/partial refund asserts quantity 8, avg_cost 50, valuation 400, COGS 150 and reversal 50 via SQL. Snapshot mutation fails. Failure/retry leaves no replay result for rolled-back creation. Legacy NULL snapshot, short receipt, overreceipt, insufficient stock and store/tenant denial are covered by the existing costing/HTTP tests.

At the NUMERIC(18,2) maximum, snapshot and destination cost preserve exact `9999999999999999.99` text. NUMERIC(18,3) addition at maximum is rejected before mutation. SQL asserts unchanged balance row (including version/time), movement count, replay count and transfer status after overflow. Receipt total overflow rolls back its already-attempted balance/movement writes. Catalog refuses unsafe numeric rendering. Generic server-error regression remains HTTP 500.

NOT VERIFIED: exhaustive deadlock/lock-timeout injection, high-load stress, simultaneous cancellation against every other writer, complete four-role transaction/action matrix. Existing basic races are not evidence of every possible interleaving.

## Compatibility, policies and release blockers

Old frontend/new backend retains optional-reference compatibility; old clients without a reference are not retry-safe. New frontend requires reconciliation support and retains one immutable intent across reload. Old backend/new schema is schema-compatible but financially unsafe: old writers can introduce NULL snapshots or bypass new receipt costing. Drain all old writers; no mixed-writer rollout or rollback.

Legacy NULL snapshot operations remain manual review/fail closed, without filling from current/global price. Short receipt values actual received quantity and is final with a difference reason; overreceipt is rejected. No automatic variance income/expense is booked. In-transit valuation, shortage accounting, negative balances, residual allocation and legacy correction remain accounting decisions. Existing seller-filter refund attribution uses refund operator in finance reports; independent AI seller reporting may use original seller. Cross-operator seller policy was not changed and requires explicit business review.

Production GO requires final exact-HEAD CI success, independent financial/security review, the remaining browser/concurrency coverage, approved accounting exception handling, approved maintenance window, verified production-like restore, legacy transfer review and operator-approved cutover. Passing build/production scripts alone is not release authorization.
