# Warehouse 031 manual rollout

These commands are for an explicitly authorized operator. Do not run production migration, push, or deployment during the audit. Use a backed-up database and a maintenance window with stock writes paused. Securely configure `NODE_ENV=production`, `MIGRATION_DATABASE_URL` (direct Neon endpoint with TLS), and `DATABASE_URL` (pooled Neon endpoint with TLS) for the same intended database. Do not print credentials or change deployment settings. Use the audited Git commit without changing its migration files between preflight and execution.

From the backend directory, run the read-only preflight:

```powershell
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\Freemustafa\Zenix-POS-production-final\Zenix POS\backend'
node .\scripts\warehouseAudit.mjs before
if ($LASTEXITCODE -ne 0) { throw 'Stop: warehouse preflight failed' }
```

The audit uses the migration runner's direct connection. It requires verified matching checksums for 001–030, exactly 031 pending, and no unknown migration records. It runs `031_warehouse_preflight.sql` in a read-only repeatable-read transaction with timeouts and rejects any nonzero violation count. It checks orphan balances/batches, nonfinite or null quantities, and partially existing 031 artifacts. `manufactured_date` must be absent before 031. Stop on failure; do not repair business records automatically.

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

The post-migration audit requires every catalog checksum to match with no pending or unknown migrations. It runs `031_warehouse_integrity.sql` and schema verification against the same direct database. Every count must be zero before resuming writes. The full outer comparison catches warehouse partitions without aggregate balances, including zero-sum orphan partitions. It also checks default warehouses for every store, scope, dates, finite quantities, validated warehouse constraints, valid indexes, and enabled deferred, identity and truncate guards.

Migration 031 takes fail-fast locks before backfill and runs transactionally; a busy database aborts rather than waiting indefinitely. Existing conflicting writers make it fail with `55P03`; writers arriving after locks are acquired wait until commit or rollback. Retry only after confirming the database is quiet and rerunning preflight. An application request can time out during this interval, so keep stock writes paused until the post-audit passes. Branch/product/organization keys on an inventory balance are immutable; use the existing stock-transfer flow. Do not drop warehouse tables or reverse the backfill after stock activity. Restore only through an approved recovery procedure if necessary. The audit scripts report counts and catalog metadata without business records; SQL files remain separately inspectable for database review.

Disposable PostgreSQL 17.11 audit: migration 001–030 checksum/business preservation, 031 commit, busy-lock rejection, injected-failure rollback, queued sale/receipt/store creation, concurrent stock updates, partition/default/scope guards, numeric boundaries, NaN, batch dates, and read-only before/after audits passed. These results are local; no Neon production preflight or migration was executed during this audit.
