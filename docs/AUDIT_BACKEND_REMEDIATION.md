# Backend, financial and security remediation

## Baseline and implementation plan

- Backend branch: audit/backend-finance-security-remediation, based on fetched main b41bd550. Preserved prior local phase2/pos-pro branch a357b6a9; it is an ancestor of main.
- Frontend branch: same name, based on production hotfix f5eae0e. Fetched main remains08d29dc; hotfix commits1a7dc89 andf5eae0e remain preserved.
- The required ZENIX_POS_MASTER_AUDIT_85_FINDINGS_2026-10-25.md was absent from both working trees, fetched main trees and the project parent directory. Its location/content has been requested. Full85-ID traceability cannot be honestly completed from omitted descriptions.
- No production writes, deploy, main merge, forced reset or historical financial backfill.

### Execution sequence
1. Locate/read original audit; classify original IDs without inventing descriptions.
2. Reproduce NEW-01 field-level customer RBAC; add authoritative permission and frontend contract.
3. Reproduce NEW-02 cash repayment omission; add transactional ledger/allocation/shift movement provenance with replay protection and additive migration.
4. Reconcile SHIFT-01 from one authoritative database snapshot; validate large shifts and close races.
5. Audit costing/report/timezone, supplier/file/replay/transfer/security domains, fixing only evidenced safe defects.
6. Run required syntax, unit, migration/schema/integrity, DB and authenticated HTTP tests against the isolated loopback database.
7. Fill all four requested reports, review diffs, commit/push both branches and prepare PRs without merging/deploying.

### Isolated test environment
Existing embedded PostgreSQL18 binaries reused; a new cluster under workspace .task/master-remediation-pg-20261025 listens only at127.0.0.1:55435. Database zenix_master_remediation_test_20261025 is newly created and disposable. Production credentials are not used. Existing test safety gates remain unchanged and continue rejecting Neon hosts.

## Implemented changes

1. Customer financial-field authorization is independent of contact edit permissions; frontend controls and payloads match the server contract.
2. Customer repayment now has atomic cash provenance, allocation, replay and audit with migrations041/042. No historical rows were rewritten.
3. Shift UI reads authoritative server cash summaries; close detects a stale expected amount.
4. Supplier invoice creation has transactional replay protection (043).
5. File purpose/owner/tenant/branch authorization and attachment locks close independent file exposure/race paths (044); frontend upload/proxy contract updated.
6. Finance endpoint omits unauthorized expense data/counts/profit. Branch expense cutoffs match sales; customer overdue follows tenant calendar. New workspace timezone/HH:mm settings are validated.
7. Existing DB suites now execute sequentially because one suite recreates the public test schema. Existing source-contract tests follow extracted services and new schema; a license fixture now computes expiry in the fixture tenant's UTC calendar.
8. Branch-specific cost maps reach catalog/bootstrap and frontend valuation. Receipt/sale calculations preserve real zero average cost. Receipt metadata attachment paths use the same file binding guard as product CRUD. Two-branch database reproduction passes; transfer/return policy remains open.

Details, decisions and incomplete coverage are in [financial reconciliation](AUDIT_FINANCIAL_RECONCILIATION.md), [database/security](AUDIT_DATABASE_SECURITY.md) and [original-ID traceability](AUDIT_85_TRACEABILITY.md).

## Verification ledger

All database commands below target only the loopback disposable database with NODE_ENV=test and matching DATABASE_URL/TEST_DATABASE_URL/MIGRATION_DATABASE_URL.

|Command / scope|Result|
|---|---|
|npm run check|PASS; syntax modules checked|
|npm run db:verify|PASS;44 migrations,64 tables,190 indexes|
|npm run migrate:status|PASS; no missing/drifted/unknown/unverified migrations locally|
|npm run db:audit-integrity|PASS; required tenant relationships have zero violations locally|
|npm run test:db|PASS60/60 after UTC fixture correction|
|npm run test:http|PASS2/2|
|Backend npm test|PASS816, FAIL0, SKIP17;833 total in final serialized run|
|Frontend npm test|PASS303/303, FAIL0, SKIP0 after final code review fixes|
|Frontend npm run build|PASS|
|New file HTTP matrix|PASS8/8, including cross-store and lock-wait race|
|Customer/shift/supplier HTTP and DB|Targeted suites passed; included in final backend run|
|Original85 audit coverage|NOT VERIFIED: audit source missing; only31 IDs named in prompt|
|Browser/device verification|NOT VERIFIED for these backend contract changes; frontend component/integration tests and build were run|
|Production deployment / writes|Not performed|

Initial concurrent DB runs failed because schema-reset integration cases overlapped; those runs are not represented as passing evidence. Serialization changes execution order only, preserving assertions. Optional separately configured AI/resource/subscription integration suites may remain skipped by their existing environment gates; these are NOT VERIFIED, not PASS.

The17 existing optional gates cover AI action/conversation/provider/read/report/restock suites, release/preflight/recovery, resource capacity/limits/HTTP and subscription database/HTTP/upgrade scenarios. No new skip was introduced. Their dedicated environment aliases were not configured; passing standard DB/HTTP suites does not verify them.

Final code review also caught product edits accidentally sending projected branch cost as global reference cost. Product save now retains `referenceCostPrice`, including zero, with a regression check. Source changes are concentrated in backend customer/shift/supplier/file/finance/inventory/time/permission services and routes; frontend customer/shift/product/expense upload state, permissions and proxy; migrations041–044; targeted regression tests and these four reports. No CSS/design tokens were changed.

Progressive POS catalog normalization uses the same selected-branch cost map and preserves reference cost. Final frontend build and staged `git diff --check` pass. Backend optional17 integration scenarios and full85 source traceability remain explicitly unverified.

## Rollout and remaining issues

This branch is review-only. Apply migrations before backend code; deploy matching frontend contract changes for cash repayment and purpose uploads. External API clients must supply stable customer/invoice references and file purpose. Review default financial permission assignments before rollout. Additive rollback retains financial provenance and replay rows; do not destructively drop/backfill production records.

Missing audit source, refund attribution, selected expense date policy, transfer/return costing, supplier advance/cash provenance and allocation history, exhaustive authorization/stress and restore rehearsals remain open. This report does not certify that85 findings were resolved.
