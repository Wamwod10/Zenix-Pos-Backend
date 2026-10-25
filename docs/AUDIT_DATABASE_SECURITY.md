# Database and security remediation

## Environments and read-only production evidence

Testing uses newly created loopback PostgreSQL18, `zenix_master_remediation_test_20261025`, not Neon production. Existing test-target safety gates were preserved.

Read-only Neon catalog checks found 40 applied migrations through040; all40 source checksums match. Production has219 foreign keys,68 unvalidated constraints and no invalid/not-ready indexes. Migration016 intentionally introduced tenant FKs as NOT VALID: new writes are constrained, but historical validation is not established by their presence.

Eight read-only aggregate orphan checks returned zero: customer-ledger customer, allocation payment/credit, shift movement shift, inventory balance store/product, sale seller and supplier payment invoice. This is limited evidence, not a claim that every historical invariant or reference has been inspected. No client rows or secrets are included here.

## New migrations (local only)

| Migration | Purpose |
|---|---|
|041|Nullable repayment shift/register/reference provenance; tenant FKs and unique payment/movement links.|
|042|Deferred reciprocal cash consistency constraints for new linked repayments; no legacy backfill.|
|043|Extend allowed financial replay operations with supplier invoice creation.|
|044|Nullable file purpose (`product`/`expense`), preserving historical rows.|

Deployment must apply migrations in order before backend code using their columns, then coordinate frontend API changes. A code rollback can leave additive columns/constraints in place. Do not drop financial provenance or erase replay records to roll back. Reverting mandatory client contracts requires an explicit compatibility decision. No production migration, deployment, schema validation or backfill was executed.

## Security changes

- Financial customer fields are authorized on the server independently of contact edit permission.
- Finance history-only users cannot obtain expense details, counts or profit aggregates. Analytics-only access receives permitted aggregates without details.
- Uploads require `X-File-Purpose: product|expense` and matching write permission. Binding validates tenant, purpose and uploader/admin ownership. Legacy purpose is inferred from existing references without rewriting rows.
- Product images remain available to authorized POS/inventory readers. Expense attachment reads/binds/deletes enforce referenced branch scope; shared conflicting references fail closed.
- File row locking and a fresh post-lock policy read serialize attachment/deletion and cross-purpose races. UUID/MIME/content validation remains in place. Frontend upload callers and proxy preserve the purpose header.
- Financial replay locks, organization/shift/customer ordering and transaction rollback receive real database coverage.

## Authorization scope

Customer HTTP tests exercise OWNER, ADMIN, MANAGER, CASHIER, SALES, WAREHOUSE and PLATFORM_ADMIN, explicit grants/denials, foreign organization IDs and revoked sessions. File tests exercise same-tenant purpose boundaries, uploader ownership, branch scope and concurrency. Existing authentication/tenant HTTP regressions remain required. These are not exhaustive certification of every endpoint/role combination.

|Default role|Customer contact edit|Customer financial profile|Cash repayment control|
|---|---|---|---|
|OWNER|Allowed|Allowed (existing owner wildcard)|Scoped open shift|
|ADMIN|Allowed|Allowed; explicit denial respected|Scoped shift with reconciliation permission|
|MANAGER|Allowed|Denied unless explicitly granted|Scoped shift with reconciliation permission|
|CASHIER|Allowed|Denied unless explicitly granted|Own open shift; register identity required|
|SALES|Allowed|Denied unless explicitly granted|Requires shift permission in addition to sales|
|WAREHOUSE|Denied without sales grant|Financial grant alone does not grant sales module|Requires sales+shift permissions|
|PLATFORM_ADMIN|No organization endpoint access|Denied|Denied|

## Remaining verification

Full historical FK validation, backup restore/PITR rehearsal, production pooling saturation, every deep-pagination query plan, all serial/FEFO/transfer races, OTP replay/rate-limit matrix and complete endpoint authorization matrix are NOT VERIFIED by this remediation alone. A production constraint-validation rollout requires measured lock/scan planning; it was not run automatically.
