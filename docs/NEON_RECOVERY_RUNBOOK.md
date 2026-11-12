# Neon recovery (operator-controlled, production restore disabled)

`BACKUP_PROVIDER=neon`, `NEON_API_TOKEN`, `NEON_PROJECT_ID`, and `NEON_BRANCH_ID` enable the read-only adapter. `BACKUP_API_TOKEN` is a legacy fallback. Existing HTTP and tenant-manifest adapters remain supported. Keep credentials server-side in a secret manager. Use a separate disposable Neon project for validation; never supply production project identifiers for tests. The app only invokes GET on the fixed official Neon API origin. Use the least project-scoped permission allowing project and snapshot reads. A read-only credential must not be reused for a restore exercise.

Official contracts: [list snapshots](https://api-docs.neon.tech/reference/listsnapshots), [create snapshot](https://api-docs.neon.tech/reference/createsnapshot), [restore snapshot](https://api-docs.neon.tech/reference/restoresnapshot), [OpenAPI schema](https://neon.com/api_spec/release/v2.json).

Neon snapshots are DATABASE scope, covering every tenant on the selected branch. Missing source-branch metadata is excluded and counted as unscoped. Snapshot listing does not supply a readiness status, so status is UNKNOWN. Creation time, captured timestamp, LSN, expiry, and size are shown only when returned by the provider. Project history retention does not prove the earliest recoverable timestamp. No successful backup date is fabricated from UNKNOWN status. The listing endpoint currently has no documented pagination parameters; the app validates a bounded provider result (10,000 maximum) and pages locally using deterministic created-at/id ordering. Larger responses fail closed.

## Disposable provider drill — NOT executed without external credentials

1. Operator creates a new empty disposable Neon project and records its project/branch IDs. Confirm no production lineage, endpoints, or real customer data. Use a separate write-capable test-only credential. Record explicit operator sign-off and rollback plan before any write.
2. Apply unchanged migrations plus approved additive migrations to this disposable branch only. Seed at least two synthetic tenants with products, stock movements, sales, refunds, credit payments, and balances. Record `db:verify`, `db:audit-integrity`, and source row manifests. Exercise financial and stock equations with the existing PostgreSQL integration fixtures.
3. Invoke documented `POST /projects/{project_id}/branches/{branch_id}/snapshot`. Record actual snapshot ID and operation IDs. Poll returned operations to completion. Do not blindly repeat non-idempotent POST after timeout. List and confirm captured branch/timestamp metadata.
4. Change only synthetic fixtures on this source branch. Confirm differences are detected. Keep immutable pre-change offline export for comparison.
5. Invoke `POST /projects/{project_id}/snapshots/{snapshot_id}/restore` with a new test recovery name and **`finalize_restore:false`**. Do not finalize, move existing computes, or replace any shared branch. Capture returned new branch ID and operations; validate source and recovered IDs are distinct. Provision only a disposable endpoint if required.
6. Export the recovered test branch into a separate local test database. Do not place database URLs or provider tokens in command output or evidence. Offline source and target copies are required for stable comparisons.
7. Set `RECOVERY_SOURCE_DATABASE_URL` and `RECOVERY_TARGET_DATABASE_URL` to two independent loopback test databases; run `node scripts/verifyRestoreDrill.mjs > restore-comparison.json`. This reads every tenant using bounded canonical row fingerprints, including ledger, stock movements, dependent records, and tenant foreign-key integrity. Any row cap, missing schema, tenant difference, or failed integrity check prevents a complete result. `providerRestoreVerified:false` remains deliberate: this local comparison cannot attest that the operator actually invoked Neon restore. Keep provider operation evidence separately.
8. Run financial/stock regression tests on the recovered disposable copy. Confirm cross-tenant permission denial, unchanged tenant inventories, referential integrity, and known synthetic financial expectations. Record actual commands and outputs.
9. Record operator-reviewed evidence, unresolved limitations, rollback validation, and cleanup plan. Delete only explicitly verified disposable resources using the operator's own tooling. The application never exposes an automatic restore action.

Live connection, snapshot creation, and isolated provider restore drill remain BLOCKED until a test-only project credential and operator execution evidence are supplied. Mock/contract tests prove adapter behavior, not provider backup availability or restore success.


## 2026-10-30 incident prevention: connector preflight (no provider mutation)

The 2026-10-30 incident (frontend issue #97) shows that restoring a snapshot
to a **new** branch through the connected Neon tool can reassign the production
compute **by default**. Original production branch and endpoint were restored
after the incident, but transient API and authentication failures were possible.
Do not perform a rehearsal restore without an approved change ticket, fresh
provider readbacks, and the explicit non-finalizing option.

**Important API distinction:**
- ChatGPT/Neon connector tool restore_snapshot requires **finalize: false**.
  Omitting it defaults to **true** for newly created branches.
- Raw Neon HTTP API uses its own documented field
  **finalize_restore: false** for a new nonproduction branch; verify the
  currently published API contract before using raw HTTP.
- The names are **not interchangeable**. Do not send the raw HTTP field to the
  connector and do not rely on either default.
- For rehearsal, never supply target_branch_id, call finalize_branch_restore,
  move computes, switch branch names, or repoint any production endpoint.

**Pinned production identity, read-only verified 2026-11-12:**

- project ID: steep-wind-39440568
- protected/default branch ID: br-small-dew-b197rvkz
- active read-write endpoint ID: ep-patient-field-b1xbogfo

An intentional identity change requires a separately reviewed baseline change,
not an automatic safety bypass.

### Static local preflight

Obtain fresh read-only get_default_branch, list_postgres_endpoints, and
list_snapshots results and record the snapshot source branch and compute
mapping. Create a temporary local JSON file like this, substituting the latest
snapshot ID and a genuine operator change approval reference:

    {
      "project_id": "steep-wind-39440568",
      "approval_reference": "OPS-97-approved-change-reference",
      "production_branch": {
        "id": "br-small-dew-b197rvkz",
        "project_id": "steep-wind-39440568",
        "name": "production",
        "default": true,
        "protected": true,
        "current_state": "ready"
      },
      "production_endpoint": {
        "id": "ep-patient-field-b1xbogfo",
        "branch_id": "br-small-dew-b197rvkz",
        "type": "read_write",
        "current_state": "active"
      },
      "snapshot": {
        "id": "snap-REPLACE-WITH-REAL-SNAPSHOT",
        "source_branch_id": "br-small-dew-b197rvkz"
      },
      "restore_request": {
        "project_id": "steep-wind-39440568",
        "snapshot_id": "snap-REPLACE-WITH-REAL-SNAPSHOT",
        "name": "zenix-rehearsal-nonprod-20261112",
        "finalize": false
      }
    }

Command: node scripts/checkNeonRestorePlan.mjs /path/to/plan.json

This **offline static validator** has no Neon API client, DB connection,
restore, write or cleanup capability. Its output deliberately says
providerReadbackAuthenticated: false and providerRestoreVerified: false:
input JSON may be stale or spoofed. STATIC_PLAN_VALIDATED is **not** proof
of live provider state or permission to execute a restore. Never commit
tokens, database URLs or customer data in the plan or its logs.

At the moment of separately approved execution, independently recheck the
original production branch and endpoint mapping again. Immediately after any
operator-executed restore, independently verify that original branch stays
default/protected and that original production endpoint stays mapped to it,
while the new restore branch remains nondefault and isolated. Any mismatch:
**stop and follow the incident runbook** rather than attempting automatic
remediation. Validate full financial and stock manifests using isolated
exports, document actual RPO/RTO and cost, and obtain separate approval for
cleanup. No provider restore is authorized by this document.
