# Warehouse 031/032 manual rollout

These commands are for an explicitly authorized operator. Do not run production migration, push, or deployment during the audit. Use a backed-up database and a maintenance window with stock writes paused. Securely configure `NODE_ENV=production`, `MIGRATION_DATABASE_URL` (direct Neon endpoint with TLS), and `DATABASE_URL` (pooled Neon endpoint with TLS) for the same intended database. Do not print credentials or change deployment settings. Use the audited Git commit without changing its migration files between preflight and execution.

From the backend directory, run the read-only preflight:

```powershell
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\Freemustafa\Zenix-POS-production-final\Zenix POS\backend'
node .\scripts\warehouseAudit.mjs before
if ($LASTEXITCODE -ne 0) { throw 'Stop: warehouse preflight failed' }
```

The audit uses the migration runner's direct connection. It requires verified matching checksums for applied migrations and either exactly 031+032 pending (fresh rollout) or exactly 032 pending (031 already applied), with no unknown records. It runs `031_warehouse_preflight.sql` for a fresh rollout or `032_warehouse_preflight.sql` for an upgrade in a read-only repeatable-read transaction with timeouts and rejects any nonzero violation count. It checks orphan balances/batches, nonfinite or null quantities, and partially existing 031 artifacts. `manufactured_date` must be absent before 031. On an existing 031 database, missing warehouse rows for zero aggregate balances are permitted only during preflight so 032 can repair them; every other mismatch fails. Preserve the applied 031 file and checksum. Stop on failure; do not repair business records automatically.

Only after production migration is explicitly authorized and preflight passes, run:

```powershell
# Recheck immediately before the authorized migration.
node .\scripts\warehouseAudit.mjs before
if ($LASTEXITCODE -ne 0) { throw 'Stop: warehouse preflight failed' }
npm run migrate
if ($LASTEXITCODE -ne 0) { throw 'Stop: migration failed; inspect transaction outcome' }
node .\scripts\warehouseAudit.mjs after
if ($LASTEXITCODE -ne 0) { throw 'Stop: warehouse post-migration audit failed' }
npm run db:verify
if ($LASTEXITCODE -ne 0) { throw 'Stop: runtime database schema verification failed' }
```

The post-migration audit requires every catalog checksum to match with no pending or unknown migrations. It runs `032_warehouse_integrity.sql` and schema verification against the same direct database. Every count must be zero before resuming writes. The full outer comparison catches warehouse partitions without aggregate balances, including zero-sum orphan partitions and missing warehouse partitions for zero aggregate balances. It also checks default warehouses for every store, scope, dates, finite quantities, validated warehouse constraints, valid indexes, and enabled deferred, identity and truncate guards.

Migrations 031 and 032 run transactionally with fail-fast locks; a busy database aborts rather than waiting indefinitely. Existing conflicting writers make it fail with `55P03`; writers arriving after locks are acquired wait until commit or rollback. Retry only after confirming the database is quiet and rerunning preflight. An application request can time out during this interval, so keep stock writes paused until the post-audit passes. Branch/product/organization keys on an inventory balance are immutable; use the existing stock-transfer flow. Do not drop warehouse tables or reverse the backfill after stock activity. Restore only through an approved recovery procedure if necessary. The audit scripts report counts and catalog metadata without business records; SQL files remain separately inspectable for database review.

Migration 032 verification must be run against an explicitly configured disposable test database. No Neon production preflight or migration is authorized by these instructions.

Migration 032 also maintains a separate version row for each inventory balance. Deferred checks write that row before checking totals, causing conflicting repeatable-read transactions to abort with PostgreSQL `40001` instead of accepting stale partition presence. It leaves inventory quantities unchanged; a `40001` failure requires retrying the entire transaction. The post-audit checks version-row presence, scope, validated foreign key and supporting unique indexes.

Disposable Neon verification (never uses production as a write target): securely configure local NEON_API_KEY and NEON_PROJECT_ID, then run from the backend directory:

```powershell
node .\scripts\neonWarehouseAudit.mjs
if ($LASTEXITCODE -ne 0) { throw 'Stop: disposable Neon verification failed' }
```

The runner API-creates a randomly named disposable branch, verifies it is neither default nor protected, binds the direct connection to that exact branch endpoint, and runs the migration audit in fresh test databases. It deletes only its own verified branch after tests. The general database test safety gate continues to reject Neon. Never bypass a failed identity check or point generic test commands at production.

Audit evidence (2026-10-12): final SQL/schema checks passed six disposable local PostgreSQL 17.11 integration tests, including rollback, concurrent stock workflows and repeatable-read write-skew reproduction/fix. Targeted unit/safety tests passed 32/32; changed JavaScript syntax checks passed. Migration files 001?031 remain unchanged. Disposable Neon execution is pending NEON_API_KEY/NEON_PROJECT_ID configuration; local PostgreSQL results do not satisfy the Neon release gate. No production SQL, push or deployment was executed.
