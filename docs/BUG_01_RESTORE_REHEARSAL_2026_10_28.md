# BUG-01 — independent Neon snapshot restore and migration rehearsal (2026-10-28)

**Scope:** authorized pre-production work only. This report supersedes the **staging restore SKIP** status in the older `BUG_01_FINAL_RELEASE_GATE_2026_10_27.md` for the **backup restore sub-gate**, but does **not** change the overall release decision from **NO-GO**.

## Branches, retention and approval

- Production project: `steep-wind-39440568`; production/default branch `br-small-dew-b197rvkz`; DB `neondb`.
- Source backup: `snap-sweet-mountain-b1nmxspo` from the pre-045/046 production schema.
- With the user's explicit authorization, archived October 10 root branch `br-young-glade-b14wt0iv` was deleted **after** creating and confirming preservation snapshot `snap-delicate-bar-b1ume7l2`. Other historical branches and production were not deleted, reset or reassigned.
- Independent restored root branch: **`br-nameless-credit-b18fhfgm`**, `zenix-045-046-real-snapshot-restore-rehearsal-20261028`; restore used `finalize:false`; **READY**, own compute active, **non-default**. No restored staging data was routed to production.
- Source restored records: **44 migrations, 140 sales, 108 inventory balance records, 1 dispatched legacy transfer**.

## Migration result: PASS on the actual restored snapshot

Applied exact committed backend PR migration files to **the restored staging branch only**, each as an atomic PostgreSQL transaction and recorded SHA-256 checksum:

| Applied migration | SHA-256 |
| --- | --- |
| `045_transfer_cost_snapshot.sql` | `f482a8101d0394a033f18f2c5fe35f47dd818d48690f64916a2070ae22886037` |
| `046_transfer_create_replay.sql` | `cf90cc8f9bcb4abc0bebe08a86a7c2b3ede73103ef87c98a4e98229578b00ead` |

- **46 migrations** applied after rehearsal, with snapshot column and enabled immutable trigger.
- Native Neon schema diff against untouched production contains only the expected 045/046 changes: nullable `stock_transfer_items.unit_cost_snapshot`, nonnegative check, snapshot protection function/trigger, extended replay operation check permitting `transfer_create`.
- Deliberate migration failure injection inside a transaction (add a probe column, then divide by zero): **rollback PASS**, probe column absent after failed transaction, migration count still 46.
- Snapshot immutability exercise on the legacy fixture: overwriting a non-NULL snapshot rejected by check-violation exception; the original legacy NULL remained unchanged.
- Reconciliation after migration: **108 inventory balances**, **zero** quantity/warehouse-partition mismatches, **zero** negative balances/costs, **zero** sale-document sum mismatches, **zero** accumulated refund-total mismatches, **zero** orphan returns and invalid sold items.
- Observed restored stock valuation: `230991996.56` UZS. This is an inventory snapshot, **not an approved accounting correction**.

## Separate release conditions — NOT satisfied by restore alone

1. An existing **100-unit dispatched legacy transfer** still has NULL cost snapshot (see backend PR #19's manual-review evidence). Historical receipt, sale and batch records suggest 12,000 UZS per unit, but this must not be automatically backfilled, received or written off.
2. Historical refund/return cost movement provenance differs for three legacy returns. The aggregate original sale COGS is 143,000 UZS; it is **not proven lost profit**. Track as [issue #20](https://github.com/Wamwod10/Zenix-Pos-Backend/issues/20) for read-only historical reconciliation and accountant review.
3. Full application writer-drain/quiescence and orderly old-backend → 045/046 → new-backend → new-frontend cutover has **not** been rehearsed through actual Render/Vercel traffic gating. Mixed old/new financial writers are unsafe.
4. Exhaustive backend lock-timeout/stress, four-role real HTTP transaction/action and cross-operator seller-report cases have not been independently verified across all relevant interleavings. Existing basic integration/concurrency tests are positive evidence, not complete coverage.
5. In-transit/shortage/overage/rounding-residual accounting exception policy and monitoring/rollback ownership still require sign-off. Preserve fail-closed behavior where not approved.

## Current candidate status when this report was written

- Backend [PR #19](https://github.com/Wamwod10/Zenix-Pos-Backend/pull/19): code including transfer costing/replay and transfer role-action security matrix; exact-head CI should always be verified again after this document commit.
- Frontend [PR #31](https://github.com/Wamwod10/Zenix-Pos/pull/31): rebased/merged with released BUG-02–04 frontend patch; retry branch at `52085fce71e3f5a22ec2af0d643c55251d94abf7`, PR CI run [40574385309](https://github.com/Wamwod10/Zenix-Pos/actions/runs/40574385309) SUCCESS.
- BUG-02–04 independent frontend patch already on live Vercel production `8d8109b73e6f4ad98bdef6af968aae1f2400d6c3`.
- Untouched backend production remains deployed from `71db18030c5abcb56190c4c7c9d6d15722cb5c5f` and production Neon remains at **44 migrations**.

**Decision:** **backup/restore + staging migration sub-gate PASS; full financial backend production release still NO-GO.** The next cutover must retain a proven rollback strategy and must not introduce mixed-version writers or mutate historical financial records without scoped accounting review.
