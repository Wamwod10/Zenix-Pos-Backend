# MVP18 Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the separate Zenix POS frontend and backend repositories safe to commit and push by resolving every Critical and Important MVP18 review finding and proving the release against unit, contract, build, migration, and disposable PostgreSQL checks.

**Architecture:** Keep the backend authoritative for tenant scope, pricing, inventory, promotions, and store access; expose bounded server-side directory contracts; and treat persisted frontend carts only as intent that must be reconciled with hydrated catalog and stock. Preserve additive migrations, use no-transaction concurrent indexes for live tables, and verify transaction/concurrency behavior with bounded database tests.

**Tech Stack:** Node.js 20+, Express 5, PostgreSQL 16, `pg`, Zod 4, React 19, Vite 8, Node test runner, Docker.

**Spec:** `docs/superpowers/specs/2026-10-09-mvp18-production-hardening-design.md`

## Global Constraints

- Frontend and backend remain separate sibling repositories; neither repository may embed the other.
- Organization scope and all security, pricing, stock, promotion, and store-access decisions remain server-authoritative.
- Migrations are additive and deterministic; live-table indexes use `-- migrate:no-transaction` plus `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
- Entitlements use the half-open interval `starts_on <= business_date AND expires_on > business_date` everywhere.
- Business-rule failures expose stable machine codes and actionable Uzbek messages; logs must not expose credentials, connection URLs, receipts, customer PII, or recovery rows.
- No production database access or destructive down migration is permitted.
- Release push remains gated on external rotation of the historically exposed Neon credential and deployment-secret update.

## Review Focus

- A restored cart containing a deleted/archived item, a changed price, insufficient stock, and invalid tracking selections keeps valid intent, removes unsafe data, and reports every change (Task 7 tests).
- Two concurrent submissions for the final promo slot cannot both reserve it, while an already reserved immutable quote survives later promo deactivation (Task 3 tests).
- An inventory count with historical batch tracking but no positive batch rows still creates the traceable unknown-expiry batch and ends with exact aggregate equality (Task 2 tests).
- A store write waiting behind an organization lock observes a newly committed suspension, paywall, expiry, capacity breach, or explicit hold before any business write (Task 5 tests).
- Customer directories larger than 60 rows retain deterministic full-dataset filter/sort behavior at page boundaries and reset to page one when controls change (Tasks 6 and 8 tests).

---

### Task 1: Reliable Database Harness and Safe Migration Layout

**Files:**
- Modify: `tests/databaseIntegration.test.mjs`
- Modify: `tests/tenantIntegrityMigration.test.mjs`
- Modify: `migrations/020_extra_store_entitlements.sql`
- Create: `migrations/021_mvp18_concurrent_indexes.sql`
- Create: `migrations/022_mvp18_guarded_constraints.sql`
- Modify: `src/db/verifySchema.js`

**Interfaces:**
- Consumes: existing migration runner support for the first-line `-- migrate:no-transaction` directive.
- Produces: migration 021 concurrent unique/index creation; migration 022 catalog-guarded constraints; bounded database concurrency tests that always release clients.

- [ ] **Step 1: Write the failing migration and harness tests**

Add assertions that migration 020 contains only transactional schema changes, migration 021 uses `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS`, migration 022 guards constraint creation, concurrent runners converge, and the receipt-reuse setup completes within the configured `lock_timeout`.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- --test-name-pattern="migration|receipt reuse|concurrent runner"`
Expected: FAIL on blocking index/unguarded constraint or receipt test timeout.

- [ ] **Step 3: Split migration responsibilities and repair the test setup**

Move live-table indexes out of migration 020, create them concurrently in 021, add guarded foreign keys in 022, and create both receipt fixtures before acquiring the conflicting organization lock. Set bounded `lock_timeout` values and release every checked-out client in `finally`.

- [ ] **Step 4: Verify unit migration contracts**

Run: `npm test -- --test-name-pattern="migration|receipt reuse|concurrent runner"`
Expected: PASS.

- [ ] **Step 5: Commit the migration/harness unit**

Run: `git add migrations/020_extra_store_entitlements.sql migrations/021_mvp18_concurrent_indexes.sql migrations/022_mvp18_guarded_constraints.sql src/db/verifySchema.js tests/databaseIntegration.test.mjs tests/tenantIntegrityMigration.test.mjs && git commit -m "fix: harden MVP18 migrations and DB harness"`

### Task 2: Exact Inventory Batch Reconciliation

**Files:**
- Modify: `src/routes/inventory.js`
- Modify: `tests/transaction-contract.test.mjs`
- Modify: `tests/databaseIntegration.test.mjs`

**Interfaces:**
- Consumes: locked organization/store/product IDs, requested final balance, and batch-tracking metadata inside the existing inventory-count transaction.
- Produces: `reconcileCountBatches(client, { organizationId, storeId, productId, requestedBalance }) -> Promise<void>` whose postcondition is the locked store batch sum equals `requestedBalance`.

- [ ] **Step 1: Add failing reconciliation tests**

Cover pre-existing aggregate drift, zero-positive historical lots, other-store lots, decrease, increase, exact equality, deterministic lot consumption, and serial-tracked exclusion. Assert the final batch sum exactly equals the requested balance.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --test-name-pattern="batch reconciliation|inventory count"`
Expected: FAIL for drift and zero-positive historical-lot cases.

- [ ] **Step 3: Implement locked-sum reconciliation**

Lock every matching batch row including zero-remaining history, compute `requestedBalance - lockedBatchSum`, consume positive batches in deterministic expiry/ID order, and create or extend the `INVENTORY-COUNT` / `EXPIRY-UNKNOWN` batch when the sum is low.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --test-name-pattern="batch reconciliation|inventory count"`
Expected: PASS.

- [ ] **Step 5: Commit inventory reconciliation**

Run: `git add src/routes/inventory.js tests/transaction-contract.test.mjs tests/databaseIntegration.test.mjs && git commit -m "fix: reconcile counted inventory to batch totals"`

### Task 3: Atomic Promo Reservation Lifecycle

**Files:**
- Create: `migrations/023_promo_reservations.sql`
- Modify: `src/services/promoCodes.js`
- Modify: `src/routes/billing.js`
- Modify: `src/services/billingReview.js`
- Modify: `tests/mvp18PromosAndPricing.test.mjs`
- Modify: `tests/billingReview.test.mjs`
- Modify: `tests/databaseIntegration.test.mjs`

**Interfaces:**
- Consumes: immutable pending billing payment, promo code, organization ID, plan/type, quoted discount, and the caller transaction client.
- Produces: `reservePromo(client, input)`, `consumePromoReservation(client, paymentId)`, and `releasePromoReservation(client, paymentId, reason)`; all return idempotent reservation state and lock promo/payment rows before quota decisions.

- [ ] **Step 1: Write failing lifecycle and concurrency tests**

Assert submission reserves capacity atomically; active reservations plus uses enforce global/tenant quota; duplicate submission is idempotent; deactivation blocks only new reservations; approval consumes once; rejection/expiry releases once; and two concurrent final-slot submissions yield exactly one reservation.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --test-name-pattern="promo|reservation"`
Expected: FAIL because pending payments do not reserve quota.

- [ ] **Step 3: Add reservation schema and service operations**

Create one reservation per payment with explicit `RESERVED`, `CONSUMED`, and `RELEASED` states and named constraints. Implement the three interfaces so quota reads count active reservations plus consumed uses under locks.

- [ ] **Step 4: Wire submission and review transitions**

Reserve in the same transaction that creates the pending discounted payment; consume during approval; release during rejection/expiry/other terminal paths; translate only known named constraint failures.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- --test-name-pattern="promo|reservation|billing review"`
Expected: PASS.

- [ ] **Step 6: Commit promo reservations**

Run: `git add migrations/023_promo_reservations.sql src/services/promoCodes.js src/routes/billing.js src/services/billingReview.js tests/mvp18PromosAndPricing.test.mjs tests/billingReview.test.mjs tests/databaseIntegration.test.mjs && git commit -m "fix: reserve promo capacity for pending payments"`

### Task 4: Complete Billing Period Arithmetic

**Files:**
- Modify: `src/config/billing.js`
- Modify: `tests/mvp18PromosAndPricing.test.mjs`
- Modify: `tests/extraStoreEntitlements.test.mjs`

**Interfaces:**
- Consumes: validated `startsOn` and `expiresOn` calendar dates accepted by billing drafts.
- Produces: `billableMonths(startsOn, expiresOn) -> number` with arithmetic full-period coverage, deterministic month-end behavior, and no 120-month truncation.

- [ ] **Step 1: Add failing long-period tests**

Assert periods of 120, 121, and the maximum accepted months, leap/month-end transitions, invalid dates, and reversed dates; preserve the current UZS rounding increment.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --test-name-pattern="billable months|extra-store pricing"`
Expected: FAIL at 121+ months.

- [ ] **Step 3: Replace the capped loop with calendar arithmetic**

Calculate complete month spans from normalized calendar parts and apply the existing partial-month/month-end rule. Throw the existing validation error for invalid or reversed periods.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- --test-name-pattern="billable months|extra-store pricing"`
Expected: PASS.

Run: `git add src/config/billing.js tests/mvp18PromosAndPricing.test.mjs tests/extraStoreEntitlements.test.mjs && git commit -m "fix: price full extra-store billing periods"`

### Task 5: Transactional Store Authorization and Business Dates

**Files:**
- Modify: `src/services/storeTradingHolds.js`
- Modify: `src/routes/sales.js`
- Modify: `src/routes/shifts.js`
- Modify: `src/routes/stores.js`
- Modify: `src/routes/bootstrap.js`
- Modify: `src/routes/auth.js`
- Modify: `tests/storeTradingHolds.test.mjs`
- Modify: `tests/storeCapacityExpiry.test.mjs`
- Modify: `tests/databaseIntegration.test.mjs`

**Interfaces:**
- Consumes: transaction client, organization ID, store ID, and current organization business date derived from the locked timezone.
- Produces: `lockStoreTradingAuthorization(client, input) -> Promise<{ businessDate, effectiveStoreLimit }>` or a stable coded business-rule error before protected writes.

- [ ] **Step 1: Add failing authorization/date tests**

Cover operations queued behind newly committed suspension, billing hold, license expiry, capacity breach, and explicit store hold; same-day expiry boundaries; entitlement `expires_on === business_date` inactive behavior; and a UTC/local-date trial boundary.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --test-name-pattern="trading hold|store capacity|business timezone|trial expiry"`
Expected: FAIL where the post-lock read omits access fields or dates use UTC/inclusive expiry.

- [ ] **Step 3: Revalidate all access state after the organization lock**

Select license status/expiry, settings suspension and billing hold, timezone, base limit, active entitlements, and explicit store holds from the locked transaction; reject before sale/shift/store writes with stable codes and Uzbek messages.

- [ ] **Step 4: Unify half-open entitlement and timezone date logic**

Make bootstrap expose active status for historical rows and exclude inactive rows from capacity; calculate trial expiry against the organization's business timezone.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- --test-name-pattern="trading hold|store capacity|business timezone|trial expiry"`
Expected: PASS.

Run: `git add src/services/storeTradingHolds.js src/routes/sales.js src/routes/shifts.js src/routes/stores.js src/routes/bootstrap.js src/routes/auth.js tests/storeTradingHolds.test.mjs tests/storeCapacityExpiry.test.mjs tests/databaseIntegration.test.mjs && git commit -m "fix: revalidate store access under organization lock"`

### Task 6: Complete Platform and Customer Directory Contracts

**Files:**
- Create: `src/services/customerDirectory.js`
- Modify: `src/routes/customers.js`
- Modify: `src/services/platformDirectory.js`
- Modify: `src/routes/platform.js`
- Modify: `tests/database-production.test.mjs`
- Modify: `tests/transaction-contract.test.mjs`
- Modify: `tests/databaseIntegration.test.mjs`

**Interfaces:**
- Consumes: organization ID plus validated `q`, `filter`, `sort`, `direction`, `limit`, and `offset` query parameters.
- Produces: `parseCustomerDirectoryQuery(searchParams) -> CustomerDirectoryQuery` and `buildCustomerPageQuery(input) -> { text, values }`; API response `{ items, total, limit, offset }` with deterministic customer-ID tie-breaking.

- [ ] **Step 1: Add failing directory contract tests**

Cover more than 60 customers, every filter (`all`, `debtors`, `overdue`, `vip`), each sort (`name`, `spend`, `debt`, `overdue`) in both directions, final page boundaries, invalid/bounded inputs, tenant isolation, SQL parameterization, and platform list/detail agreement for billing hold and trial metadata.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- --test-name-pattern="customer directory|platform directory"`
Expected: FAIL because filtering/sorting is incomplete and platform page rows omit settings.

- [ ] **Step 3: Implement the bounded customer query service**

Validate allowlisted values, build organization-scoped predicates and sort fragments without interpolating user text, calculate total independently of the page, and append customer ID as the deterministic tie-breaker.

- [ ] **Step 4: Include settings in platform page rows**

Select the settings needed by the existing view mapper so list and detail derive billing/trial metadata identically.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- --test-name-pattern="customer directory|platform directory"`
Expected: PASS.

Run: `git add src/services/customerDirectory.js src/routes/customers.js src/services/platformDirectory.js src/routes/platform.js tests/database-production.test.mjs tests/transaction-contract.test.mjs tests/databaseIntegration.test.mjs && git commit -m "feat: serve complete bounded directories"`

### Task 7: Frontend POS Cart Reconciliation

**Files:**
- Create: `../frontend/src/utils/posCartReconciliation.js`
- Modify: `../frontend/src/pages/sales/Sales.jsx`
- Modify: `../frontend/src/utils/posDraft.js`
- Modify: `../frontend/tests/mvp18DraftAndExport.test.mjs`

**Interfaces:**
- Consumes: persisted cart lines, hydrated current products, current-store inventory, current serials/batches, and store ID.
- Produces: `reconcilePersistedCart(input) -> { lines, changes, hasBlockingStockIssue }`; `changes` classifies removed products, price changes, removed tracking selections, and insufficient stock for cashier messaging.

- [ ] **Step 1: Add failing pure reconciliation tests**

Cover price increase/decrease, archived/deleted products, insufficient stock, invalid/wrong-store serial and batch selections, valid discount/quantity preservation, and identical outcomes for draft/local-hold/server-hold sources.

- [ ] **Step 2: Run focused tests and verify failure**

Run from `../frontend`: `node --test tests/mvp18DraftAndExport.test.mjs`
Expected: FAIL because persisted snapshots are restored directly.

- [ ] **Step 3: Implement the pure reconciler**

Rebuild authoritative product fields from hydrated state, retain only valid user intent/tracking references, return structured changes, and never perform checkout-side mutation.

- [ ] **Step 4: Route every restore path through reconciliation**

Delay draft restoration until workspace hydration completes; use the same utility for local and server-held carts; display actionable change/stock warnings while preserving remaining valid lines.

- [ ] **Step 5: Run focused tests and commit in the frontend repository**

Run: `node --test tests/mvp18DraftAndExport.test.mjs`
Expected: PASS.

Run: `git add src/utils/posCartReconciliation.js src/utils/posDraft.js src/pages/sales/Sales.jsx tests/mvp18DraftAndExport.test.mjs && git commit -m "fix: reconcile persisted POS carts"`

### Task 8: Frontend Server Pagination and Async Preference Safety

**Files:**
- Modify: `../frontend/src/pages/customers/Customers.jsx`
- Modify: `../frontend/src/pages/customers/customers.scss`
- Modify: `../frontend/src/pages/platformAdmin/PlatformAdmin.jsx`
- Modify: `../frontend/src/context/StoreContext.jsx`
- Modify: `../frontend/.github/workflows/verify.yml`
- Modify: `../frontend/tests/integrityHardening.test.mjs`
- Modify: `../frontend/tests/deepAudit.test.mjs`

**Interfaces:**
- Consumes: Task 6 customer API response `{ items, total, limit, offset }` and existing platform request-generation state.
- Produces: server-driven customer controls/page state; guarded organization usage updates; theme callbacks keyed by the complete per-user storage key; pinned CI Playwright version.

- [ ] **Step 1: Add failing frontend contract tests**

Assert customer query parameters and page reset on search/filter/sort; visible range and total on page boundaries; stale reversed-order organization usage responses are ignored; two same-role users receive distinct theme keys; and workflow Playwright install uses an exact version.

- [ ] **Step 2: Run focused tests and verify failure**

Run from `../frontend`: `node --test tests/integrityHardening.test.mjs tests/deepAudit.test.mjs`
Expected: FAIL on client-only directory logic, missing usage guard, stale callback dependency, or unpinned CI dependency.

- [ ] **Step 3: Implement server-driven customer state**

Send debounced search/filter/sort/limit/offset to the backend, reset offset to zero when controls change, render the returned page without client re-sorting, and show total plus the 1-based visible range.

- [ ] **Step 4: Guard async usage and preference writes**

Capture organization ID plus request generation before usage fetch and check both before updating; include the full per-user theme key in callback dependencies.

- [ ] **Step 5: Pin Playwright and run focused tests**

Use the repository-compatible exact Playwright version in CI.

Run: `node --test tests/integrityHardening.test.mjs tests/deepAudit.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit frontend directory/safety work**

Run: `git add src/pages/customers/Customers.jsx src/pages/customers/customers.scss src/pages/platformAdmin/PlatformAdmin.jsx src/context/StoreContext.jsx .github/workflows/verify.yml tests/integrityHardening.test.mjs tests/deepAudit.test.mjs && git commit -m "fix: harden frontend directory and async state"`

### Task 9: Recovery Safety and Full Backend Verification

**Files:**
- Modify only if a focused test fails: `src/services/tenantRecovery.js`
- Modify only if a focused test fails: `scripts/compareTenantRecovery.mjs`
- Modify: `tests/recoveryRowManifest.test.mjs`
- Modify: `tests/tenantRecovery.test.mjs`

**Interfaces:**
- Consumes: tenant ID and allowlisted recovery-table manifest.
- Produces: bounded read-only counts/fingerprints with fail-closed missing-child-manifest behavior and content-safe logs.

- [ ] **Step 1: Extend recovery safety tests**

Assert read-only SQL, organization predicates, bounded work, deterministic fingerprints, no raw values/credentials in output, and failure when a required child table is absent from the manifest.

- [ ] **Step 2: Run recovery tests and implement only missing behavior**

Run: `node --test tests/recoveryRowManifest.test.mjs tests/tenantRecovery.test.mjs`
Expected: PASS after any required minimal correction.

- [ ] **Step 3: Run the full backend unit and syntax gates**

Run: `npm test`
Expected: all non-database tests PASS with only explicitly documented database skips.

Run: `npm run check`
Expected: syntax check PASS for every module.

- [ ] **Step 4: Commit recovery/test corrections if any**

Run: `git add src/services/tenantRecovery.js scripts/compareTenantRecovery.mjs tests/recoveryRowManifest.test.mjs tests/tenantRecovery.test.mjs && git commit -m "test: enforce read-only tenant recovery safety"`

### Task 10: Disposable PostgreSQL and End-to-End Release Verification

**Files:**
- No planned source changes; failures return to the owning task and receive a focused regression test before correction.

**Interfaces:**
- Consumes: completed Tasks 1-9 and a disposable PostgreSQL 16 connection string.
- Produces: evidence for empty/repeated/concurrent/populated migration, schema status, authenticated HTTP, frontend contract/build/audit/readiness/design, and clean intended Git state.

- [ ] **Step 1: Start a disposable PostgreSQL 16 container**

Use a unique container/database name, bind only to localhost, wait for readiness, and set task-scoped `DATABASE_URL`/test confirmation variables without printing the URL or password.

- [ ] **Step 2: Exercise migration safety**

Run empty migration, rerun it, run concurrent migration workers, rehearse a populated pre-MVP18 upgrade, then run `npm run migrate:status` and `npm run db:verify`.
Expected: no missing, drifted, unverified, or unknown migration; schema verification PASS.

- [ ] **Step 3: Run backend database and HTTP suites**

Run: `npm run test:db`
Expected: PASS without timeout.

Run: `npm run test:http`
Expected: PASS.

- [ ] **Step 4: Run all frontend gates**

Run from `../frontend`: `npm test`, `npm run test:with-backend`, `npm run build`, `npm run audit`, `npm run verify:production`, and `npm run verify:design`.
Expected: every command PASS; production build has no unresolved import or environment error.

- [ ] **Step 5: Remove the disposable container and inspect both repositories**

Remove only the exact verified temporary container. Run `git status --short --branch`, `git diff --check`, and secret-pattern scans in both repositories; verify no nested frontend/backend copies, generated artifacts, runtime secrets, or unrelated files are staged.

- [ ] **Step 6: Perform final review and commit remaining intended changes**

Review every staged diff against the spec, then create one coherent final commit per repository only for uncommitted intended release files.

- [ ] **Step 7: Apply the release gate**

Do not push or describe the release as deployable until external Neon credential rotation and deployment-secret update are independently confirmed. Once confirmed, push backend first, verify health/readiness, then push frontend and smoke-test the production flow.
