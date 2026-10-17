# Platform hardening — 2026-10-18

Scope: first verified safety fixes against main (including merged AI PR #13).
Preserve design, pricing, existing data and deployment configuration.

Implementation plan:
- Reproduce refund replay accepting a changed payment split or shift; bind new refunds to the full validated request and retain legacy replay compatibility.
- Reproduce frontend losing financial retry identities after HTTP timeout/conflict; retain uncertain identities across refund, customer payment, checkout and receipt flows.
- Reproduce rejection of explicit hypothetical Uzbek advice; exempt only the conditional clause while preserving evidence, numerical and execution guards.
- Run targeted regressions, disposable PostgreSQL POS integration, broader suites and frontend build; record actual results and limits.
- Deliver separate reviewable PRs without merge, deployment or production migration.

Remaining platform audit: exhaustive browser/role/device matrix and comparable production latency measurements are outside these initial verified fixes. No claim of full platform acceptance.

## Findings and changes

- P1: refund replay checked product/quantity/method but ignored changed payment split, shift and metadata. New refunds store a server-computed full validated intent fingerprint. Legacy rows retain their existing replay behavior; no backfill or migration.
- P1 (frontend companion): HTTP 408/425/429 and unclassified 409 responses could release financial retry identity. Shared rejection classification now retains it for checkout, receiving, refunds and customer payments. Refunds persist the original full payload across refresh/date/shift changes, and incomplete success responses cannot acknowledge refunds.
- P2: evidence validation rejected explicit hypothetical Uzbek trends such as “Agar savdongiz kamaygan bo‘lsa”. Only that conditional clause is exempted; subsequent claims, numbers and execution claims still require validation.
- P2 QA: finance fixtures lacked an active subscription/register; cross-repository contracts referenced pre-refactor bootstrap/receipt code. Fixtures now satisfy actual guards and assertions follow the authoritative service.
- P2 QA: full migration catalogue takes roughly 25 seconds on this local Docker host, exceeding the integration test's 15-second override. Serialization now uses the unchanged runner default (120 seconds), with a separate test proving lock expiry prevents any schema access and releases the client.
- POS HTTP PostgreSQL integration now runs explicitly in backend CI instead of being skipped without TEST_DATABASE_URL.

## Verification

- Backend standalone final: 612 passed, 0 failed, 51 skipped (explicit database/environment gates).
- Frontend standalone final: 263 passed, 0 failed, 0 skipped.
- Frontend cross-repository final: 120 passed, 0 failed, 2 skipped (external browser acceptance).
- Disposable PostgreSQL POS + AI conversation: 33 passed, 0 failed, 0 skipped.
- Broader PostgreSQL run (catalog, migrations, auth/RBAC, subscription, resource limits, warehouse, finance, AI reports): initially 87 passed / 2 failed. Both failures investigated; corrected finance fixture passes and migration serialization passes individually. Original failed logs are retained in workspace .task/hardening-broad-db.log.
- Backend syntax: 153 modules passed. Frontend build, source audit, readiness and design checks passed; 23 CSS/SCSS baseline files unchanged.
- Read-only independent review: no remaining concrete findings after fixing immutable refund retries.

## Performance and limits

Existing synthetic budgets passed: 50k POS search P95 1.054 ms; 10-line cart against 50k map P95 0.049 ms; 10k analytics filter P95 0.575 ms. Main gzip 117,471 bytes; total JS gzip 422,715 bytes. These are local CPU/build results, not network or production latency. No comparable before measurement or production speed improvement is claimed.

No exhaustive live module/device/role audit, real barcode/printer exercise, 1k/10k/50k remote catalog network comparison, live OpenAI evaluation or production load test has been completed. Provider behavior in integration tests is controlled. These remain follow-up work; this delivery is a verified initial hardening increment.

## Release

No production data, configuration or infrastructure was changed. No new schema migration is required. Review and complete PR CI first; release the frontend immutable retry payload before enabling the stricter backend replay check. Validate retry/reconciliation in staging, then deploy only with explicit release authorization. Existing pending journals created by older clients cannot retroactively recover their original payload.
