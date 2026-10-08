# MVP18 Production Hardening Design

**Date:** 2026-10-09

## Purpose

Prepare the current standalone frontend and backend changes for a safe production push. The release must preserve tenant isolation, keep billing and store access server-authoritative, prevent stale POS data from charging customers incorrectly, and prove the new migrations and concurrency rules against disposable PostgreSQL before deployment.

The frontend and backend remain separate sibling repositories. Neither repository may embed a copy of the other.

## Release Gate

The release is eligible for commit and push only when:

- all Critical and Important review findings in this document are resolved;
- frontend standalone and cross-repository contract tests pass;
- backend unit, syntax, disposable PostgreSQL, and authenticated HTTP integration tests pass;
- migrations apply to an empty database, rerun without changes, and report no missing, drifted, unverified, or unknown entries;
- the frontend production build, audit, readiness, and visual-baseline checks pass;
- both Git worktrees contain only the intended release changes; and
- the previously exposed Neon credential has been rotated outside Git and the deployment secret has been updated.

Credential rotation is an external operational prerequisite. Removing a credential from the current `.env.example` does not revoke it or erase it from Git history. No production database access is part of this implementation.

## 1. POS Draft and Held-Cart Reconciliation

Persisted carts are references to cashier intent, not authoritative product snapshots. After workspace hydration, every restored draft or held-cart line must be rebuilt from the current product catalog and current store inventory.

The reconciliation operation will:

- match each line by product ID against the current catalog;
- discard missing or archived products and report them to the cashier;
- use current product name, price, tax/tracking configuration, and store stock;
- preserve the requested quantity, allowed discount input, and still-valid serial/batch selections;
- remove tracking selections that no longer exist or belong to another store;
- flag insufficient stock instead of silently completing the sale;
- report price changes before checkout; and
- apply identically to local drafts, local held carts, and server-held carts.

The backend remains the final authority for sale price, permissions, stock, and tracking validation.

## 2. Customer Directory Completeness

Customer filtering and sorting must operate on the full tenant directory rather than a first-page snapshot. The backend customer list endpoint will accept bounded, validated pagination, search, filter, and sort parameters. Every query remains organization-scoped and parameterized.

The frontend will request server-filtered pages, show the total and visible range, and reset pagination when search, filter, or sort changes. Supported server filters cover all customers, debtors, overdue accounts, and VIP customers. Supported sorts cover name, spend, debt, and overdue amount with deterministic ID tie-breaking.

## 3. Frontend Async and Preference Safety

Platform organization usage requests will use the same request-generation and organization-ID guard as detail and audit requests. A response may update the modal only when it belongs to the currently selected organization and current request generation.

Theme persistence callbacks will depend on the complete per-user storage key so switching between same-role users in one organization cannot write another user's preference record.

CI will install a pinned Playwright version rather than an unbounded latest release.

## 4. Inventory Batch Reconciliation

An approved inventory count establishes the authoritative final inventory balance. Batch reconciliation must therefore compare the requested final balance with the locked sum of the current store's batch quantities, not with the previous aggregate balance.

Within the inventory-count transaction, the backend will:

- lock all batches for the organization, store, and product, including zero-remaining historical batches when needed for tracking detection;
- calculate `requestedBalance - lockedBatchSum`;
- consume positive batches deterministically when the batch sum is too high;
- create or extend a traceable `INVENTORY-COUNT / EXPIRY-UNKNOWN` batch when the batch sum is too low;
- create that unidentified batch even when no positive batch currently remains, provided the product has historical batch tracking; and
- finish with the batch sum equal to the requested balance.

Serial-tracked inventory remains excluded from aggregate count adjustment.

## 5. Promo Reservation Lifecycle

A discounted payment must not lose its quoted promotion while awaiting manual receipt review. Promo capacity will be reserved atomically when a payment is submitted.

The reservation lifecycle is:

1. Validate promo activity, date window, plan/type eligibility, tenant quota, global quota, and draft integrity while holding the required promo/payment locks.
2. Create one reservation linked to the pending billing payment in the same transaction.
3. Count active reservations plus consumed uses against global and per-tenant limits.
4. Convert the reservation to a consumed use when the payment is approved.
5. Release the reservation when the payment is rejected, expires, or is otherwise terminal without approval.
6. Make submission, approval, rejection, and retry idempotent.

Admin deactivation prevents new reservations but does not invalidate an already valid reservation attached to an immutable pending quote.

## 6. Billing Period Correctness

Extra-store pricing must cover the complete selected calendar period without a hidden 120-month truncation. Calendar-month calculation will be arithmetic and bounded by the same validated maximum date range accepted by billing drafts. Invalid or reversed periods fail closed.

The price calculation retains deterministic month-end behavior and explicit rounding to the existing UZS increment.

## 7. Transactional Store Authorization

New sales, shifts, and other protected store writes must revalidate organization access after acquiring the organization row lock. The locked read includes:

- license status;
- timezone-aware license expiry;
- explicit platform suspension state;
- billing hold/paywall state;
- base store limit and active extra-store entitlements; and
- explicit per-store trading holds.

If an admin control commits while an operation is waiting, the waiting operation must observe the new state and fail before business writes occur.

## 8. Platform Directory and Date Consistency

Paginated platform organization queries will select the settings data required to derive billing hold and trial metadata. List and detail representations must agree.

Extra-store entitlements use one half-open active interval everywhere: active when `starts_on <= business_date` and `expires_on > business_date`. Bootstrap may include historical rows only when it also returns an explicit inactive status; inactive rows never increase effective capacity.

Trial expiry dates will be calculated using the organization's business timezone rather than UTC calendar boundaries.

## 9. Migration Strategy

Migrations remain additive. Because the current MVP18 migrations have not been pushed, their final layout may be corrected before release while retaining stable numeric ordering.

- Transactional table/column/constraint changes remain in ordinary migrations.
- Large indexes on live tables use the repository's no-transaction migration convention and `CREATE INDEX CONCURRENTLY`.
- Foreign-key constraints are added with catalog guards; production-sensitive validation may use `NOT VALID` followed by explicit validation in a controlled step.
- Migration status/checksum behavior must remain deterministic.
- Tests must cover populated-schema rehearsal, cross-tenant rejection, repeated runner execution, and concurrent runners.

No migration deletes tenant business data or silently archives stores.

## 10. Recovery Tooling

Tenant recovery comparison remains strictly read-only, bounded, tenant-scoped, and content-safe. It may report table counts and deterministic fingerprints but must not log credentials or underlying row contents. Missing child-table manifests fail closed rather than reporting equality.

## 11. Test Harness Reliability

The disposable PostgreSQL receipt-reuse test currently blocks itself by attempting a third-connection insert while another transaction holds the referenced organization row. Test setup will create all required receipts before taking the conflicting lock, or perform setup through the lock-owning transaction. The test must still prove serialization without relying on an unbounded wait.

Every concurrency test will use a bounded PostgreSQL `lock_timeout` and release clients in `finally` blocks. The disposable container is removed after verification.

## Error Handling and Observability

- Business-rule failures return stable machine codes and actionable Uzbek messages.
- Database uniqueness or foreign-key failures are translated only when the matching named constraint is known.
- Async frontend reconciliation reports changed/removed lines without discarding the rest of the cashier's draft.
- No logs include passwords, connection URLs, receipt contents, customer personal data, or raw recovery rows.

## Verification Matrix

### Frontend

- Draft reconciliation: price increase, price decrease, archive, deletion, insufficient stock, invalid serial/batch, local hold, and server hold.
- Customer directory: more than 60 rows, every filter, every sort, page boundary, search reset.
- Platform modal: rapid organization switch with reversed response order.
- Theme: two same-role users in one organization.
- Full frontend suite, combined contract suite, audit, readiness, visual baseline, and production build.

### Backend

- Batch reconciliation: pre-existing drift, zero remaining lots, other-store lots, decrease, increase, and exact equality invariant.
- Promo: concurrent final quota, reservation, deactivation after reservation, approval, rejection, expiry, and duplicate retry.
- Store authorization: operations queued behind suspend, paywall, expiry, capacity, and explicit hold changes.
- Billing periods beyond 120 months and month-end boundaries.
- Platform paginated rows with billing hold and trial metadata.
- Full backend unit and syntax suites.

### Disposable PostgreSQL

- Empty migration and repeat execution.
- Concurrent migration runners.
- Populated pre-MVP18 schema upgraded through the new migrations.
- Schema verification and migration-status checks.
- Tenant foreign-key rejection and entitlement uniqueness.
- Database and authenticated HTTP integration suites.

## Deployment and Rollback

1. Rotate the exposed Neon credential and update deployment secrets before any release push is treated as deployable.
2. Rehearse migrations on disposable PostgreSQL, then on a non-production Neon branch with production-like volume.
3. Record concurrent-index duration and constraint-validation results.
4. Deploy backend before frontend because the frontend consumes the new bounded customer and billing contracts.
5. If backend health/readiness fails, roll back the backend deployment without running destructive down migrations.
6. Deploy frontend only after backend readiness and smoke checks pass.
