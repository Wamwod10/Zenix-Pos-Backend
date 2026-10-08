# Zenix POS Phase 1 Backend Foundation Design

## Objective

Create a safe, testable backend and PostgreSQL foundation for later Zenix POS phases without changing the UI or redesigning POS, credit, refund, finance, inventory, SaaS, or Super Admin business behavior.

## Source of truth

The dedicated `Zenix-Pos-Backend` repository is the canonical backend source. The `backend/` directory inside `Zenix-Pos` remains temporarily as a compatibility mirror because deleting it before Render ownership is confirmed could break an existing deployment. The mirror must be synchronized during this phase, but new Render configuration will resolve backend services from the dedicated backend repository.

Evidence for this decision:

- `backend/` is its own clean Git repository with remote `Zenix-Pos-Backend.git`.
- `frontend/` is a separate clean Git repository with remote `Zenix-Pos.git`.
- The standalone backend has independent package, Render, migration, worker, and test configuration.
- The frontend repository contains a newer backend snapshot, including migration `011` and its non-transactional migration executor.

This phase does not delete the compatibility mirror. Its removal requires a later production deployment ownership check.

## Backend reconciliation

The canonical backend receives every verified capability present only in the compatibility mirror:

- migration `011_bootstrap_performance_indexes.sql`;
- safe execution of `CREATE INDEX CONCURRENTLY` outside a transaction;
- the associated migration regression tests;
- existing customer, product, store, and environment hardening changes and their tests.

After canonical changes are complete, the compatibility mirror receives the same backend files. A deterministic parity check compares all maintained backend files while excluding Git metadata, dependencies, and generated artifacts.

## Migration safety

Migration execution must satisfy these rules:

- obtain a PostgreSQL advisory session lock before reading or applying migration state;
- reject duplicate or malformed numeric migration prefixes;
- store a SHA-256 checksum for each migration and reject later content drift;
- keep ordinary migrations atomic with `BEGIN`, `COMMIT`, and `ROLLBACK`;
- run explicitly marked concurrent-index migrations outside a transaction;
- remove only an invalid same-name concurrent index before retrying it;
- always release the database client and advisory lock;
- never use `DROP TABLE`, `TRUNCATE`, database reset, or data deletion;
- preserve all existing rows and remain rerunnable.

The existing `schema_migrations` table is upgraded additively with a nullable checksum column. Existing rows are adopted using the checked-in file checksum on the first run; all later runs enforce equality.

## Tenant integrity

The current schema uses globally unique UUID primary keys but many tenant-owned child rows independently reference `organization_id`, `store_id`, `product_id`, or other parent IDs. Application queries usually scope them correctly, but PostgreSQL does not consistently reject a child row whose organization differs from its referenced parent.

An additive migration introduces composite tenant keys and `NOT VALID` composite foreign keys for high-risk operational relationships. PostgreSQL enforces these constraints for new writes while preserving legacy rows until a controlled validation window. A read-only integrity audit reports legacy violations without changing them. Constraint validation against production data is explicitly outside this phase.

## Transactions and concurrency

The common transaction helper will:

- expose a dependency-injected runner for deterministic tests;
- preserve the original application error if rollback also fails;
- release clients in every path;
- support an explicit isolation level without silently retrying callbacks.

Automatic transaction retries are not enabled globally because callbacks may later contain non-database side effects. Existing sale, stock, payment, credit, shift, outbox, and transfer locks remain intact. Multi-write password changes and session revocation become a single transaction. Full POS, credit, and refund business redesign remains Phase 2 work.

## Environment and connection lifecycle

Startup validation will reject invalid ports, session TTLs, database pool sizes, timeout values, origins, public API URLs, and incomplete production Telegram configuration without printing secrets. Pool configuration will use bounded connection, idle, statement, query, and idle-transaction timeouts suitable for Render and Neon pooling.

Web and worker shutdown paths will be idempotent, stop their local timers, stop accepting new HTTP traffic, drain the pool, and retain a bounded forced-exit fallback. `/health` remains process liveness; `/ready` remains database readiness.

## Deployment

- The dedicated backend repository's `render.yaml` runs from repository root, not a nonexistent nested `backend` directory.
- The frontend repository's root Render blueprint names the dedicated backend repository explicitly.
- Production database migrations are a separate controlled step. Render pre-deploy performs read-only schema verification and refuses deployment when required migrations have not been applied.
- Deployment documentation defines the order: backup/branch check, staging migration, staging verification, production migration, production verification, deploy, health check, and rollback to the prior application version if needed.
- No real GitHub, Vercel, Render, Neon, or Telegram setting is changed during this task.

## Testing

Static/unit tests cover environment validation, transaction rollback, migration checksums, lock release, concurrent migration serialization, mirror parity, tenant scoping, and graceful shutdown behavior.

Database integration tests require an explicitly named test database, reject Neon and production-looking URLs, apply migrations to an empty PostgreSQL database, rerun them, execute concurrent migrators, prove rollback behavior, and prove new cross-tenant writes are rejected. The local verification run uses an ephemeral PostgreSQL container and removes it afterward.

The final verification includes both backend suites, database integration tests, schema checks against the ephemeral database, frontend tests, frontend production readiness checks, and a production frontend build.

## Exclusions and safety boundaries

- No UI, CSS, spacing, typography, layout, responsive, or animation changes.
- No production deployment or remote configuration mutation.
- No production database connection, reset, destructive SQL, or credential disclosure.
- No deletion of either backend copy in this phase.
- No complete rewrite of POS, credit, refund, finance, inventory, SaaS, or Super Admin business logic.

## Success criteria

- The dedicated backend repository is the documented and deployment-addressed source of truth.
- Both local backend copies are functionally synchronized.
- Migration `011` is present and executable safely.
- Migration concurrency and content drift are guarded.
- New high-risk cross-tenant database writes are rejected.
- Common multi-write account operations are atomic.
- Environment and lifecycle failures are actionable and secret-safe.
- All available unit, integration, migration, tenant-isolation, production-readiness, and build checks report their real status.
