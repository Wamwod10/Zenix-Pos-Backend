# Zenix POS Phase 1 Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one deployment-addressed backend source with safe PostgreSQL migrations, tenant integrity, atomic common writes, validated runtime configuration, and verified deployment behavior.

**Architecture:** The dedicated backend repository is canonical and the frontend repository keeps a synchronized compatibility mirror. Additive PostgreSQL changes protect new tenant-owned writes, while migration execution uses a session lock, checksums, and explicit transactional modes. Runtime hardening stays in shared database/config/lifecycle modules and does not alter UI or Phase 2 business behavior.

**Tech Stack:** Node.js 20+, Express 5, PostgreSQL/Neon via `pg`, Zod 4, Node test runner, Render Blueprint, Vercel/Vite.

**Spec:** `docs/superpowers/specs/2026-10-08-phase-1-backend-foundation-design.md`

## Global Constraints

- Do not change UI, CSS, layout, fonts, spacing, responsive behavior, or animations.
- Do not connect to or mutate production Neon, Render, Vercel, GitHub, or Telegram services.
- Do not use destructive database operations or delete either backend copy.
- Preserve current APIs and working integrations; additions must be backward-compatible.
- Keep POS, credit, refund, finance, inventory, SaaS, and Super Admin business redesign outside Phase 1.
- Write each regression test first and observe the intended failure before production code.

## Review Focus

- A migrator terminated during a concurrent index must safely retry without recording a false success; Task 2 tests invalid-index cleanup and missing migration markers.
- Two deploys starting together must serialize instead of applying the same migration twice; Task 2 unit tests lock ordering and Task 6 exercises two real PostgreSQL clients.
- Existing cross-tenant legacy rows must not be deleted while new mismatched writes are rejected; Task 3 tests `NOT VALID` constraint semantics.
- A rollback failure must not hide the original business error or leak a checked-out client; Task 4 tests both errors and release behavior.
- Frontend deployment must not silently use the compatibility backend after it drifts; Task 5 tests Blueprint repository selection and mirror parity.

---

### Task 1: Reconcile the Canonical Backend

**Files:**
- Create: `migrations/011_bootstrap_performance_indexes.sql`
- Create: `src/db/migrationExecution.js`
- Create: `tests/migrationExecution.test.mjs`
- Create: `tests/fiftyThreeFixesRegression.test.mjs`
- Modify: `src/db/migrate.js`
- Modify: `src/config/env.js`
- Modify: `src/routes/customers.js`
- Modify: `src/routes/products.js`
- Modify: `src/routes/stores.js`

**Interfaces:**
- Consumes: the verified compatibility mirror implementations under the frontend repository.
- Produces: a canonical backend that contains the complete 120-test behavior currently present in the mirror.

- [ ] **Step 1: Copy the two mirror regression tests into the canonical test directory and run them to verify they fail for missing behavior.**

Run: `node --test tests/migrationExecution.test.mjs tests/fiftyThreeFixesRegression.test.mjs`

Expected: FAIL because migration execution and later hardening behavior are absent.

- [ ] **Step 2: Synchronize only the nine audited divergent files from the compatibility mirror.**

Use the mirror content for the files listed above; do not overwrite files whose hashes already match.

- [ ] **Step 3: Run the targeted tests and the canonical backend suite.**

Run: `node --test tests/migrationExecution.test.mjs tests/fiftyThreeFixesRegression.test.mjs` and `npm test`

Expected: targeted tests PASS and 120 canonical tests PASS.

- [ ] **Step 4: Commit the reconciled canonical behavior.**

Commit: `fix: reconcile canonical backend features`

### Task 2: Harden Migration Execution

**Files:**
- Modify: `src/db/migrationExecution.js`
- Modify: `src/db/migrate.js`
- Modify: `src/db/verifySchema.js`
- Modify: `package.json`
- Create: `src/db/migrationCatalog.js`
- Create: `src/db/migrationRunner.js`
- Create: `tests/migrationSafety.test.mjs`

**Interfaces:**
- Produces: `loadMigrationCatalog(directory)`, `runMigrations({ pool, directory, logger })`, and checksum-aware `executeMigration(client, migration)`.
- Consumes: PostgreSQL clients exposing `query`, `release`, and Pool `connect`.

- [ ] **Step 1: Add failing tests for malformed/duplicate prefixes, stable SHA-256 checksums, session lock ordering, checksum drift, adoption of legacy null checksums, and guaranteed unlock/release.**

Run: `node --test tests/migrationSafety.test.mjs`

Expected: FAIL because the catalog and runner exports do not exist.

- [ ] **Step 2: Implement the catalog and migration runner with a fixed advisory lock key and additive checksum column.**

`loadMigrationCatalog(directory)` returns sorted `{ name, prefix, sql, checksum, transactional }` records. `runMigrations` owns one client for the complete run, creates/upgrades `schema_migrations`, locks before reading it, rejects drift, applies missing files, and unlocks/releases in `finally`.

- [ ] **Step 3: Keep `migrate.js` as a thin executable entry point and add a read-only migration status command.**

Add `npm run migrate:status`; it must exit nonzero for missing or drifted migrations and must not apply them.

- [ ] **Step 4: Run targeted migration tests and the full backend suite.**

Expected: all tests PASS.

- [ ] **Step 5: Commit migration safety.**

Commit: `fix: serialize and verify database migrations`

### Task 3: Enforce Tenant Integrity for New Writes

**Files:**
- Create: `migrations/016_tenant_integrity_guards.sql`
- Create: `src/db/auditIntegrity.js`
- Modify: `src/db/verifySchema.js`
- Modify: `package.json`
- Create: `tests/tenantIntegrityMigration.test.mjs`

**Interfaces:**
- Produces: additive composite tenant keys, `NOT VALID` foreign keys, and `auditTenantIntegrity(db)` returning named violation counts.
- Consumes: the existing tenant-owned tables and no production credentials.

- [ ] **Step 1: Add failing contract tests that require composite keys, `NOT VALID` tenant foreign keys, no destructive SQL, required schema verification entries, and a read-only audit query.**

Run: `node --test tests/tenantIntegrityMigration.test.mjs`

Expected: FAIL because migration `016` and audit code are missing.

- [ ] **Step 2: Add composite uniqueness and high-risk tenant relationship guards.**

Cover store/product inventory, shifts, sales/returns, supplier ledgers, customer ledgers, transfers, counts, holds, billing ownership, Telegram ownership, notification ownership, files, and audit ownership. Existing single-column FKs remain in place.

- [ ] **Step 3: Implement `npm run db:audit-integrity` as read-only JSON output with secret-safe errors.**

- [ ] **Step 4: Run targeted and full tests.**

- [ ] **Step 5: Commit tenant integrity guards.**

Commit: `fix: guard tenant relationships in postgres`

### Task 4: Harden Transactions, Environment, and Shutdown

**Files:**
- Modify: `src/db/tx.js`
- Modify: `src/db/config.js`
- Modify: `src/config/env.js`
- Modify: `src/routes/users.js`
- Modify: `src/server.js`
- Modify: `src/worker.js`
- Modify: `src/services/notificationWorker.js`
- Modify: `src/services/paymentNotificationWorker.js`
- Modify: `.env.example`
- Create: `src/lib/shutdown.js`
- Create: `tests/transaction-runtime.test.mjs`
- Create: `tests/environmentValidation.test.mjs`
- Create: `tests/shutdown.test.mjs`

**Interfaces:**
- Produces: `runTransaction(db, work, options)`, strict runtime parsers, stoppable worker handles, and `createShutdownController`.
- Preserves: `withTransaction(work)` for all current callers.

- [ ] **Step 1: Add failing rollback tests for begin/work/commit, work failure, rollback failure preserving the original cause, optional isolation level, and unconditional release.**

- [ ] **Step 2: Implement `runTransaction` and keep `withTransaction` as its pool-backed wrapper.**

- [ ] **Step 3: Add failing tests for invalid port, TTL, origin, pool/timeouts, and production URLs, then implement strict parsers and bounded pool timeouts.**

- [ ] **Step 4: Add failing tests proving password/session writes use one transaction, then convert both password routes.**

- [ ] **Step 5: Add failing idempotent shutdown tests, implement stoppable worker timers, and use the shared controller in web and worker entry points.**

- [ ] **Step 6: Run targeted tests, `npm run check`, and the full backend suite.**

- [ ] **Step 7: Commit runtime hardening.**

Commit: `fix: harden transactions and runtime lifecycle`

### Task 5: Establish Deployment Source and Mirror Parity

**Files:**
- Modify: `render.yaml`
- Modify in frontend repo: `render.yaml`
- Modify in frontend repo: `backend/render.yaml`
- Modify in frontend repo: `README.md`
- Modify in frontend repo: `DEPLOYMENT.md`
- Create in frontend repo: `scripts/verify-backend-parity.mjs`
- Modify in frontend repo: `frontend/tests/deploymentBoundary.test.mjs`

**Interfaces:**
- Produces: dedicated backend Git remote selection for Render and a local mirror parity verifier invoked with `node scripts/verify-backend-parity.mjs`.
- Consumes: canonical sibling backend when available; emits a clear skip only when the sibling checkout is absent.

- [ ] **Step 1: Add failing deployment tests for standalone root execution, external canonical repo selection, read-only pre-deploy verification, and documented manual migration order.**

- [ ] **Step 2: Correct both Blueprints and deployment documentation.**

The standalone Blueprint omits `rootDir`; the frontend root Blueprint uses `repo: https://github.com/Wamwod10/Zenix-Pos-Backend.git` and also omits `rootDir` because commands run in that repository root. Pre-deploy performs status/schema verification only.

- [ ] **Step 3: Synchronize canonical backend files to the compatibility mirror and implement the parity verifier.**

- [ ] **Step 4: Run backend suites in both repositories and frontend deployment tests.**

- [ ] **Step 5: Commit frontend deployment/source changes and canonical deployment changes in their respective repositories.**

Commits: `fix: use canonical backend deployment source` and `docs: define controlled backend deployment`

### Task 6: Verify Against Ephemeral PostgreSQL and Complete the Audit

**Files:**
- Create: `tests/databaseIntegration.test.mjs`
- Create: `scripts/assertTestDatabase.js`
- Modify: `package.json`
- Create: `PHASE-1-BACKEND-FOUNDATION-REPORT.md`

**Interfaces:**
- Produces: `npm run test:db` guarded by `TEST_DATABASE_URL` and a final evidence report.
- Rejects: Neon hosts, non-loopback hosts by default, database names without a test marker, and `NODE_ENV=production`.

- [ ] **Step 1: Add failing safety-gate tests for production-looking database URLs and implement `assertSafeTestDatabaseUrl`.**

- [ ] **Step 2: Add integration tests for empty-schema migration, rerun idempotency, two concurrent migrators, transaction rollback, and cross-tenant rejection.**

- [ ] **Step 3: Start an ephemeral PostgreSQL 16 container with a random local port and disposable credentials.**

Do not use any existing environment database URL. Verify the resolved container name before removal.

- [ ] **Step 4: Run `npm run test:db`, `npm test`, `npm run check`, `npm run migrate:status`, and `npm run db:verify` against the disposable database.**

- [ ] **Step 5: Run the compatibility backend suite, frontend suite, production readiness check, audit, and production build.**

- [ ] **Step 6: Remove only the verified disposable PostgreSQL container and record every PASS/FAIL honestly.**

- [ ] **Step 7: Create the final report and commit it.**

Commit: `test: verify phase 1 backend foundation`
