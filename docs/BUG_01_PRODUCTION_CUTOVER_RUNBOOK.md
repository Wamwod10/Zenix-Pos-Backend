# Production cutover runbook — review only

This document does not authorize execution. No production action was performed. Staging restore rehearsal is **SKIP** until an operator supplies an approved isolated clone/backup and credentials. Never restore into, reassign or test against the production branch/database.

1. Record actual deployed frontend/backend SHAs, PR exact-HEAD CI links, image/artifact identifiers, schema migration names/checksums, health/readiness and error-rate baseline. Compare with reviewed candidates; abort on mismatch.
2. Obtain explicit maintenance window, responsible operator, accounting reviewer, rollback authority and communication plan. Require all final release gates and exception decisions to be signed off.
3. Run read-only inventory of pending/in-transit transfers, especially NULL snapshots. Retain a tenant-scoped, access-controlled export for manual review. Do not recost or complete legacy unknown-cost lines automatically:

```sql
BEGIN READ ONLY;
SELECT t.organization_id,t.id,t.from_store_id,t.to_store_id,t.status,
       i.product_id,i.unit_cost_snapshot
FROM stock_transfers t JOIN stock_transfer_items i ON i.transfer_id=t.id
WHERE t.status IN ('pending','approved','dispatched')
  AND i.unit_cost_snapshot IS NULL
ORDER BY t.organization_id,t.id,i.product_id;
COMMIT;
```

4. Verify an operator-created backup and **restore it to a separate approved isolated staging database**. Disable outbound notifications, payments and workers there. Validate schema checksums, immutable snapshot trigger, replay primary key/operation constraint, tenant-scoped counts and reconciliation hashes. Compare restored quantities, costs, sales/returns and completed replay responses with the backup manifest. Test 001–044 → 045 → 046 and application health/readiness. CI disposable restore is useful evidence but does not prove this production backup is restorable. Abort if restore evidence is missing.
5. Stop admission of writes and drain old application writers, workers, queued/outbox/offline clients and long transactions. Verify no old instances or sessions can commit later. Read-only traffic may continue only if operationally approved. Do not rely solely on load-balancer traffic shift.
6. With separately authorized database access, apply immutable migration 045 then 046 using the existing migrator and migration lock. Check checksums/status, snapshot column/trigger and replay operation constraint. Neither migration backfills old costs. Abort on drift, unknown migrations or failed verification; retain writer quiescence.
7. Deploy reviewed backend artifact only after schema verification. Keep old writers stopped. Do not deploy old and new financial writers concurrently.
8. Check `/health`, `/ready`, migration status, db:verify and read-only integrity audit. Inspect logs for 22003, deadlocks, lock timeouts, unknown costs, authorization denials and replay conflicts. Expected domain limits must be 4xx, genuine infrastructure errors must remain 5xx.
9. Deploy reviewed frontend artifact. Verify BUG-02 refund ranking, BUG-03 notification/recovery, BUG-04 workspace dates and both POS layouts. Old frontend may omit reference; warn operators against manual timeout resubmission until clients refresh. New frontend must not send writes to a backend without reconciliation support.
10. Only under separate operator authorization, use an isolated test tenant for smoke transactions: receipt → transfer → receipt → sale → partial/final refund. Reconcile snapshots, balances, movements, COGS and dashboard/analytics. Drop a committed response and verify reload recovers one transfer. Do not mutate real customer financial records.
11. Reopen write traffic only after accounting/operations sign-off. Confirm all old writers remain disabled and capture final deployed SHAs and gate evidence.
12. Monitor unknown-cost/manual-review queue, 409 numeric/idempotency errors, stock discrepancies, 5xx/22003, lock waits, latency and report reconciliation. Define ownership and decision thresholds before the window; do not invent monetary tolerance or variance journals during an incident.

## Failure and rollback rehearsal

In isolated staging, rehearse failure before migration, after 045, after 046 and after backend startup; verify readiness fails closed when required schema is absent. Rehearse response loss after commit, pending legacy manual review and re-opening traffic only after invariants match.

On failure: stop writes, preserve logs/replay records/snapshots and obtain an incident decision. Roll back frontend independently only when API compatibility is verified. **Do not re-enable old backend financial writers simply because the schema is additive**: they reintroduce lost cost and can create unknown snapshots. Prefer forward repair while writes remain stopped. Keep additive columns, triggers and ledger constraints; do not drop them or edit old migrations. Restoring a backup to production is a separately authorized disaster-recovery action with post-backup transaction reconciliation, not a routine code rollback. Never automatically backfill or overwrite historical financial records.

Pending NULL snapshots require manual accounting review. Shortage/overage, in-transit value and rounding residual decisions must be approved before enabling affected exceptional flows. Record an explicit GO/NO-GO with operator, reviewer, exact artifacts and backup/restore evidence.
