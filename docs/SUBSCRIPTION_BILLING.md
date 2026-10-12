# Three-tier subscription implementation and operating contract

Status: local implementation; migration 033 must not be applied to production without a separate approval.

## Architecture and scope

Keep existing organizations, billing_drafts/payments, promo reservations and the shared platform/Telegram review service. Add nullable organizations.plan_code for START/BUSINESS/PREMIUM. Existing organizations remain legacy until an explicit tier checkout; MONTHLY/ANNUAL continues to mean the billing interval. Version 1 lives in src/config/subscriptions.js; future price changes add a new immutable version. Start's stored product catalogue limit is exactly 750, including archived rows; this avoids an archive/create bypass. Other resource limits are published; independent register and AI enforcement belong to subsequent phases.

Implementation sequence: pricing/access tests → additive schema/DB write guards → registration/trial → server quotes/payment approval → scheduled downgrade/renewal → HTTP and PostgreSQL concurrency regressions. No migration 001–032 edits, production access, merge or deploy.

Tier-aware registration supplies planCode and receives a trial; MONTHLY/ANNUAL startOption is rejected with planCode. Legacy clients omitting planCode retain their former payment-required signup compatibility, mapped to Business, without choosing a subscription interval. Remove this adapter only alongside the next frontend registration rollout. GET billing/subscription returns null billingInterval during trial/unpaid signup.

## Calendar and money

New paid terms use Asia/Tashkent calendar days, independent of editable business/reporting timezone. starts_on is inclusive, ends_on exclusive. The public legacy service_period_to/expiry_date remains inclusive (ends_on minus one day). A checkout activation/upgrade starts on the approval calendar day; same-day upgrade approvals use the same fixed daily quote. Monthly/yearly terms add 1/12 calendar months, clamping month-end; actual days (including leap days) are used, never a hard-coded 30/365 denominator. Trials retain exact 14×24 hours from registration and never restart on tier change.

All new monetary arithmetic uses integer tiyin (1 UZS = 100 units), with BigInt multiplication and division. Ratios round half-up once per allocated term to 0.01 UZS. Existing promo discounts retain their historical nearest-whole-UZS calculation. No floating-point proportional credit calculation. Prices/versions/status from browser metadata are ignored.

Upgrade replaces all remaining current/future paid terms with a new full monthly/yearly term. Unused value = actual allocated term value × remaining calendar days / actual term days. Discounted/free terms grant only their paid/allocated value. Credit is capped to the target price; excess stays as subscription_credit for future checkout. Promo discount applies to the amount after credit. A zero-due order is internally confirmed once, without uploading a fake receipt. Positive orders require a tenant-owned receipt and admin approval.

Upgrade quotes are valid only on the quoted Asia/Tashkent day; delayed confirmation on another day returns SUBSCRIPTION_QUOTE_STALE with no payment/subscription mutation. Reject/requote and reconcile the already-transferred funds manually; never silently change the payable amount or lose service days. Activation quotes confirmed on a later day shift the full service interval to that approval day. Renewal never retroactively changes the current tariff.

Legacy active licenses without trustworthy allocated subscription_terms require administrator review for upgrade (LEGACY_SUBSCRIPTION_REVIEW_REQUIRED). Do not infer value from a list price. Legacy renewals and submitted EXTRA reviews keep their existing semantics; historical permanent/expiring branch rights and financial rows remain intact.

## Access and concurrency

Expiry yields READ_ONLY: authorized GET/HEAD reads remain available, bootstrap retains business data. Business writes are denied centrally in requireAuth, with database row triggers checking clock_timestamp after an organization lock. Account password/session security, per-user preferences, billing and platform controls remain available. Administrative suspension still denies access and is never lifted by billing approval.

Lock order: organization → payment/draft → promo. Payment/draft uniqueness, existing pending-review serialization and subscription_version guard duplicate/conflicting transitions. No external Telegram calls inside billing transactions. Successful approvals append a unique payment-backed term/event. Trial change and scheduled downgrade are audited and invalidate old quotes.

Downgrade is scheduled for the day after the last paid expiry, resolved on reads/writes without a worker dependency. It does not create free paid time or delete/disable existing records. A renewal of the scheduled lower tariff starts at that boundary. An expired unpaid subscription stays read-only.

An approved future lower-tier term makes downgrade cancellation/replacement a financial reconciliation, not a flag edit: the API returns FUNDED_DOWNGRADE_CONFLICT. A completed boundary cannot be undone via cancel. Platform SUSPEND/RESTORE/PAYWALL controls remain supported; legacy SET_LICENSE remains supported. Modern SET_LICENSE is explicitly rejected with TIER_LICENSE_OVERRIDE_UNSUPPORTED rather than pretending expiry/limit fields override paid terms. Restore/rejection use modern term access, avoiding reporting-timezone changes shortening paid access.

## Staging checks and rollback

Use only a disposable loopback database with a test marker; scripts/assertTestDatabase.js must accept it. Apply 001–033, run subscriptionDatabase and subscription HTTP tests, re-execute 033 in a transaction and verify payment counts/sums unchanged, then verify migration checksums/readiness. Exercise expiry, trial tier changes, promotions, duplicate approvals, concurrent last product slot, upgrade credit and delayed review, renewal/downgrade and two-tenant sale/inventory access.

Rollback before enabling new tiers: return to old code while keeping additive tables. After new paid terms exist, old code cannot safely interpret tier prices/access; use a forward compatibility release. Do not DROP terms/events, rewrite approved payments, restore a whole production database, or delete excess products. A failed transaction rolls back the review, promo use and entitlement together. Production migration/deployment remains a separate approval gate.

## Verified locally

2026-10-12: syntax check passed for 108 backend modules. Full backend suite: 429 passed, 35 skipped, zero failures (skips are separately gated integration scenarios). Explicit disposable PostgreSQL/HTTP acceptance run: 38 passed, zero skipped/failures across subscriptionMigration, subscriptionDatabase, subscriptionHttp, posHttpIntegration, httpIntegration and warehousePartitionIntegration. Migration acceptance created an empty separate loopback test database, applied 001–032, inserted test-only legacy license/payment fixtures, applied 033, replayed it, checked untouched legacy rows and verified complete schema/checksums. No production connection or deployment.

## Changed files

All paths below are relative to backend/ and describe the original billing stage. Resource and frontend additions are listed below.

- New: src/config/subscriptions.js, src/services/subscriptions.js, src/lib/requestScope.js, migrations/033_subscription_billing.sql, docs/SUBSCRIPTION_BILLING.md.
- Existing database/middleware: src/db/tx.js, src/db/verifySchema.js, src/middleware/auth.js, src/middleware/error.js.
- Existing routes: src/routes/auth.js, src/routes/billing.js, src/routes/bootstrap.js, src/routes/users.js.
- Existing services: src/services/billingDraftIntegrity.js, src/services/billingDraftMetadata.js, src/services/billingReview.js, src/services/extraStoreEntitlements.js, src/services/paymentNotificationWorker.js, src/services/paymentTelegram.js, src/services/platformOrganization.js, src/services/storeTradingHolds.js.
- New tests: tests/subscriptionPricing.test.mjs, tests/subscriptionAccess.test.mjs, tests/subscriptionDatabase.test.mjs, tests/subscriptionHttp.test.mjs, tests/subscriptionMigration.test.mjs, tests/subscriptionReviewMessage.test.mjs.
- Updated tests: tests/customers-integration.test.mjs, tests/database-production.test.mjs, tests/httpIntegration.test.mjs, tests/suspensionMiddleware.test.mjs, tests/tenantIntegrityMigration.test.mjs.

The original billing stage enforced product capacity. The resource and frontend stages below complete the other six-resource and billing-interface requirements. Legacy credit conversion and production rollout still require review; do not guess historical paid value.

## Resource and frontend stages — 2026-10-12

Completed locally, without production access, commits, pushes, merges or deployments.

### Counting and enforcement

Modern tier limits are read from the immutable database pricing catalogue and the effective subscription. PostgreSQL `resource_entitlement` and `assert_resource_capacity` are shared by the application service and row guards. Organization row locks serialize checking and writing, including direct product creation through inventory receipts. Downgrade preserves all records and active states: only growth above capacity is denied. Existing modern branches remain usable while the subscription permits writes; explicit holds and inactive branches remain protected.

| Resource | Counting | Protected HTTP paths |
|---|---|---|
| Employees | Active users except OWNER | POST `/api/users`; PATCH `/api/users/:id` activation/role changes |
| Stores | All stored branches, including main/archived | POST `/api/stores`; automatic main branch during registration |
| Warehouses | All stored warehouses across branches, including main | POST `/api/warehouses`; automatic main warehouse on branch insert |
| Registers | Active registered POS workplaces | POST `/api/registers`; PATCH `/api/registers/:id` activation; lazy registration in POST `/api/shifts/open` |
| Products | All stored products, including archived; Start exactly 750 | POST `/api/products`; product inserts in POST `/api/inventory/receive` |
| Customers | All stored customers, including archived | POST `/api/customers` |

The API returns a resource-specific 409 code and `details.resource`, `planCode`, `pricingVersion`, `limit`, `used`, `remaining`, `overLimit`, `requestedIncrease`, `upgradeRequired`, `upgradeAvailable`. Unlimited capacity is `null`. Business owners do not count as employees. Existing user deactivation preserves history, revokes sessions and prevents login.

Legacy organizations whose stored `plan_code` is null retain historical purchased rights until explicit tier conversion. Their subscription response includes `legacy:true`; legacy branch availability uses active branches and the organization's calendar. No automatic conversion or deletion occurs.

### POS model and migration

`034_resource_entitlements.sql` adds `pos_registers` and `shifts.register_id`, composite tenant foreign keys, active/default indexes and guards. Existing register keys and shift financial history are retained; historical keys become registered workplaces, even if already above new limits. The migration locks shifts, backfills only the new reference, restores the write trigger inside the same transaction, and is safe to replay. Applied 001–033 migration sources are not rewritten.

New paths: GET/POST `/api/registers`, PATCH `/api/registers/:id`, GET `/api/billing/limits`. Shift opening accepts an optional tenant-scoped `registerId`; old callers resolve the default workplace. Open shifts prevent register deactivation. Register identity/branch cannot be moved. Read access respects role and branch scope; writes also respect subscription read-only mode.

The existing shared branch shift remains unchanged: a registered workplace is distinct from a physical browser/device and from an independently reconciled cash drawer. There is still one open shared shift per branch. This stage does not introduce device fingerprinting or separate per-device cash reconciliation.

### Frontend and payment safety

Registration and checkout use the real backend catalogue. Start, Business and Premium cards share the existing design tokens; Business occupies the middle desktop/tablet position. Registration defaults to the selected 14-day trial with no billing interval. A phone that already used its trial can proceed with `startOption:PAID`, still choosing its interval only during payment. Trial switching keeps the original deadline.

Checkout exposes monthly/yearly intervals, actual computed annual savings, promotions and a persisted server quote showing gross price, unused-term credit, promo discount and final amount. Receipt upload, review polling and history remain. Zero-due orders need no fabricated receipt. Upgrade, renewal, scheduled downgrade and cancellation use the existing backend flows.

Saved drafts are revalidated server-side before restoring payment instructions. The frontend also checks subscription version, draft expiration and Tashkent upgrade date, and hides payment instructions after an authoritative refresh failure. Financial errors have explicit safe client messages. Read-only mode opens authorized data views, explains the reason and preserves billing access. The backend remains the enforcement authority.

Modern promotion discounts now round half-up to **0.01 UZS**, using integer tiyin, after credit. Final subtraction and promo-reservation validation use the same exact arithmetic. Legacy drafts retain their historical nearest-whole-UZS discount rule. PostgreSQL acceptance covers a 0.65 UZS balance with 100% discount, concurrent zero-due submission, and a fractional upgrade with 50% discount, receipt, reservation and approval of the exact allocated value.

Only billing-related styles were appended to `frontend/src/styles/saas.scss`; existing palette, fonts, layout styles and theme files remain. Its reviewed hash alone was updated in `frontend/design-baseline.json`.

### Changed files in these stages

- Backend additions: `migrations/034_resource_entitlements.sql`, `src/services/resourceLimits.js`, `src/services/posRegisters.js`, `src/routes/registers.js`, `tests/resourceLimitErrors.test.mjs`, `tests/resourceLimitsDatabase.test.mjs`, `tests/resourceLimitsHttp.test.mjs`.
- Backend updates: `src/app.js`, `src/db/verifySchema.js`, `src/middleware/error.js`, `src/routes/auth.js`, `src/routes/billing.js`, `src/routes/stores.js`, `src/routes/shifts.js`, `src/services/storeTradingHolds.js`, `src/services/subscriptions.js`, `src/services/promoCodes.js`, `tests/database-production.test.mjs`, `tests/tenantIntegrityMigration.test.mjs`, `tests/transaction-contract.test.mjs`, `tests/subscriptionMigration.test.mjs`, `tests/subscriptionPricing.test.mjs`, `tests/subscriptionHttp.test.mjs`, this report.
- Frontend additions: `src/components/SubscriptionPlans.jsx`, `src/utils/subscription.js`, `tests/subscriptionPresentation.test.mjs`, `tests/subscriptionBackend.test.mjs`.
- Frontend updates: `src/pages/register/Register.jsx`, `src/pages/billing/Billing.jsx`, `src/context/AuthContext.jsx`, `src/context/StoreContext.jsx`, `src/layout/MainLayout.jsx`, `src/utils/license.js`, `src/services/apiClient.js`, `src/styles/saas.scss`, `design-baseline.json`, `scripts/test-frontend.mjs`.
- Frontend regression updates: `tests/auditFixesFinal.test.mjs`, `tests/billingActivationNavigation.test.mjs`, `tests/billingCheckoutDraft.test.mjs`, `tests/billingReceiptError.test.mjs`, `tests/deepAudit.test.mjs`, `tests/expenseBranchScope.test.mjs`, `tests/registrationChoices.test.mjs`, `tests/registrationOtpReact.test.mjs`, `tests/warehouses.test.mjs`, `tests/fiftyThreeFixesRegression.test.mjs`, `tests/integrityHardening.test.mjs`.

### Verification actually observed

- Backend full unit/contract suite: **432 passed, 38 skipped, zero failures**. Separate integration URLs gate the skipped scenarios. Syntax: **111 modules passed**.
- Disposable local PostgreSQL 17.11/API suite: **57 passed, zero skipped/failures**, across resourceLimitErrors, resourceLimitsDatabase, resourceLimitsHttp, subscriptionHttp, subscriptionDatabase, posHttpIntegration, httpIntegration and warehousePartitionIntegration. All six resources were tested at capacity and with simultaneous final-slot requests; all tariffs, downgrade preservation, owner exclusion, inactive users/registers, roles, tenant isolation and read-only were covered.
- Migration acceptance: **1 passed** on a separate empty local database. It applies 001–032, inserts local history fixtures, applies 033–034, compares license/payment/shift history, repeats 034, and verifies schema/checksums. Final schema/034-checksum verification and **19 targeted schema tests** passed after adding register-column validation.
- Frontend `npm run test:with-backend`: **342 passed, 1 skipped, zero failures**. The skipped browser/database test was run explicitly below.
- Real Chromium → Vite → Express → PostgreSQL acceptance: **7 passed, zero failures**. It verifies prices, savings, chosen trial/deadline, actual receipt/review/activation, upgrade credit, deferred downgrade, expired views/write denial and public registration. Layout assertions and screenshots cover **390, 768, 1440 px**, light and dark themes; desktop and mobile screenshots were visually inspected. No API response mocks are used in this test. Admin approval executes the real billing service in the disposable database.
- Frontend build passed. Design baseline: **22/22 stylesheets passed**, with only the intentional billing stylesheet hash changed.

Reproduction: use a loopback URL accepted by `scripts/assertTestDatabase.js` with a `_test` database name, set `NODE_ENV=test` and `DATABASE_URL`, and set `RESOURCE_TEST_DATABASE_URL`, `SUBSCRIPTION_TEST_DATABASE_URL`, `TEST_DATABASE_URL` to that same disposable database for the listed backend integration tests. `SUBSCRIPTION_MIGRATION_TEST_DATABASE_URL` must point to a separate empty test database. For the browser test, set `SUBSCRIPTION_UI_TEST_DATABASE_URL` and run `node --test tests/subscriptionBackend.test.mjs` from frontend; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an already-installed browser. No production credentials are required.

### Rollback and remaining release issues

Before rollout, rehearse 033–034 on a production-shaped isolated staging database and benchmark organization-lock contention/import volume. No staging or production deployment was performed here. Legacy paid credit without reliable allocated terms still requires administrator review.

Rollback is a compatible application release that retains additive schema, cash/stock history, payment terms and registers. Do not drop these tables, delete excess resources, alter approved financial records or disable subscription guards as a shortcut. Once new tier payments/workplaces are live, an old billing/shift UI is not a safe blind rollback; retain the new contracts or ship a forward fix. Rejected transactions leave resource counts and financial records unchanged.

AI quota values are displayed from the catalogue; the AI execution service is outside these completed stages. Production migration, merge and deployment remain pending explicit authorization.
