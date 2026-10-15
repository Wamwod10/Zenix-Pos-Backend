# ZENIX POS performance audit ? 2026-10-16

## Delivery status

Tested optimization tranche, **not completion of all P0/P1/P2 requirements**. No production data, deployment settings or production migrations changed. No production load tests. Existing AI PRs remain intact.

Latest GitHub refs fetched before implementation: frontend main 072df993eefac3df4d0cb010c9acc33b348ff343, AI #19 head 6b69a9f03bfecabb02a02c586a5d45fe5494c0a2; backend main fbeda47a7e0da242e03fa0aedfcfd657b0015732, AI #11 head 2b6d876cc5b0dbd64420200c96ea5015c241fe05. These were the only open PRs. Both performance branches start from AI heads, with PR base feature/ai-intelligence-2. Retarget only after those AI PRs merge.

## Root causes and changes

1. POS search rebuilt and lowercased product name/SKU/barcode strings for every product on each input change. A memoized, inventory-snapshot-scoped text index now normalizes once. Matching, order, archived filtering, categories and original product objects are preserved. No global business-data cache.
2. Cart reconciliation rebuilt two full catalog maps for a small basket. It now accepts the existing projected-inventory Map and shares catalog/stock lookup when they are the same snapshot. Branch stock, serial/batch selection, discounts, packaging and duplicate-line detection remain verified.
3. Scanner keydown listener captured an unready add callback after hydration; its dependency list also omitted checkout/recovery guards. Real browser consecutive-scan test failed, and JSDOM held-cart regression reproduced quantity staying 3 instead of 4. The add callback is now stable until its guards change, and the listener depends on it. Listener cleanup still clears partial scanner buffers.
4. Bootstrap constructed three Intl.DateTimeFormat instances per record across sales/returns/shifts/suppliers. Three formatters are now reused for one request only. UTC, Tashkent, DST boundaries, midnight, leap day and independent organization timezones match legacy output.

Runtime files: frontend src/pages/sales/Sales.jsx, src/utils/posCatalogSearch.js, src/utils/posCartReconciliation.js; backend src/routes/bootstrap.js, src/lib/bootstrapDates.js. New behavioral tests and reproducible benchmark scripts accompany them. No CSS/SCSS changed.

## Method and limits

Windows, Node 24.11.1, installed Chromium headless shell, local Vite production builds, PostgreSQL 16 in a disposable Docker container bound to loopback. Synthetic data only. DB schema migrated locally with all subscription/RBAC/write guards enabled. Existing dependencies reused.

CPU search: 270 observations per size after warmup, equivalent-result assertions across queries/categories. CPU cart: 100 observations, 10 lines. Dates: 30 observations, 1,000 rows. Browser: 30 post-warmup input-event-to-result-DOM-commit observations per viewport, 50,000 products; mobile CPU throttle 4x, other widths 1x. Network is intercepted and unthrottled. **DOM commit is not measured physical paint.** Baseline production browser builds load the exact original Sales and reconciliation source from the GitHub PR head. API: 30 authenticated loopback HTTP observations after 3 warmups, including auth, SQL, serialization and client JSON parsing. Baseline API restores only the old formatter factory; SQL is unchanged.

These are small local cohorts on a shared workstation, not confidence intervals, internet latency, hosting SLAs or real-device certification. A later laptop cohort showed P95 variance/regression despite lower P50; it is reported rather than hidden. Earlier dev-mode mobile P95 was 1005.8 -> 820 ms; CPU profile attributed much of that cost to jsxDEV. Dev timings are excluded from release claims.

## Before / after (milliseconds)

| Module | Operation | Before P50 | Before P95 | After P50 | After P95 | Improvement | Test Environment | Status |
|---|---|---|---|---|---|---|---|---|
| POS | Search CPU, 100 products | 0.0299 | 0.0978 | 0.0027 | 0.0071 | 92.7% P95 | synthetic Node | improved |
| POS | Search CPU, 1k products | 0.2152 | 0.4671 | 0.0217 | 0.0798 | 82.9% P95 | synthetic Node | improved |
| POS | Search CPU, 10k products | 1.5934 | 2.6055 | 0.1497 | 0.3459 | 86.7% P95 | synthetic Node | improved |
| POS | Search CPU, 50k products | 8.2463 | 10.1208 | 1.0200 | 2.4916 | 75.4% P95 | synthetic Node | improved |
| POS | Cart validation CPU, 50k / 10 lines | 5.2748 | 12.4304 | 0.0111 | 0.0206 | 99.8% P95 | synthetic Node | improved |
| Backend | Date serialization CPU, 1k rows | 140.48 | 189.85 | 2.72 | 3.06 | 98.4% P95 | synthetic Node | improved |
| POS | Search 50k, 390px (4x CPU) | 78.80 | 131.00 | 41.80 | 96.90 | 26.0% P95 | local production build | improved |
| POS | Search 50k, 768px (1x CPU) | 11.70 | 16.60 | 7.90 | 14.10 | 15.1% P95 | local production build | improved |
| POS | Search 50k, 1366px (1x CPU) | 13.90 | 17.90 | 9.00 | 20.30 | -13.4% P95 | local production build | P95 worse; noisy cohort |
| POS | Search 50k, 1920px (1x CPU) | 12.10 | 20.00 | 8.90 | 15.80 | 21.0% P95 | local production build | improved |
| Backend | Bootstrap HTTP, 1k products / 1k sales | 199.16 | 295.22 | 71.63 | 90.96 | 69.2% P95 | local disposable PostgreSQL | improved |
| AI | OpenAI full response / first token | ? | ? | ? | ? | ? | no real-model benchmark | not measured |
| DB | Neon connection wait / query latency | ? | ? | ? | ? | ? | production not load-tested | not measured |

P99: CPU 50k search 13.1822 -> 3.6516 ms; cart 17.1356 -> 0.0455 ms; date CPU 448.8751 -> 3.1569 ms. Bootstrap HTTP 309.78 -> 105.59 ms. Browser P99 by width: 390: 142.00 -> 106.30; 768: 19.00 -> 14.20; 1366: 23.00 -> 30.60; 1920: 24.60 -> 26.30 ms. No claim of statistical significance from these small samples.

Index setup at 50k: 14.41 ms in the measured CPU run. Tradeoff: retain one normalized string per active product until its inventory snapshot is replaced. Full-catalog bootstrap memory and initial hydration remain unresolved at large scale.

## API, PostgreSQL and bounded read load

Unchanged catalog endpoint, 50-row page and common matching search: measured HTTP P50/P95 at 100 products 14.15/21.80; 1k 9.17/22.96; 10k 6.92/22.84; 50k 6.51/24.55 ms. These are scale observations, **not a catalog API speedup claim**. The query pattern matches early rows; rare/no-match searches need separate plans.

EXPLAIN ANALYZE executed only in the disposable database. Existing products_org_created_id_paging_idx was used. Execution times at 100/1k/10k/50k: 0.364/0.286/0.190/0.205 ms, respectively; 50k planning 0.408 ms. No new indexes or migrations proposed from these results. Empty fixture stock tables do not represent a populated multi-warehouse workload.

Fixture generation exposed another bottleneck: resource_entitlement counts catalog rows per insert even for unlimited Premium; a large single insert hit the existing 30-second statement timeout. Bounded 1,000-row batches completed 50k without disabling guards. This is an unresolved import/write-performance issue; read endpoint timing excludes seed time. Any future DB function migration needs separate review, concurrency/limit-boundary tests, lock timeout and rollback preparation. No historical migration checksums changed.

200 authenticated read requests per concurrency level, **1,000-product fixture**, existing pool configuration. This is a bounded read-load check, not sustained soak/stress, 50k concurrency, or concurrent checkout certification. CPU and RSS deltas/event-loop delay are retained in local JSON; shared-host noise and GC make them unsuitable as Render capacity estimates.

| Concurrent readers | Before P50 / P95 / P99 | After P50 / P95 / P99 | After failures |
|---|---|---|---|
| 1 | 5.68 / 9.46 / 11.68 | 12.32 / 21.06 / 33.68 | 0/200 |
| 10 | 19.47 / 27.39 / 29.34 | 24.39 / 43.55 / 53.26 | 0/200 |
| 50 | 93.43 / 105.31 / 118.67 | 100.95 / 132.89 / 147.66 | 0/200 |
| 100 | 166.81 / 204.45 / 213.91 | 172.46 / 208.24 / 218.49 | 0/200 |

The formatter optimization does not change the catalog route. Variance in that route is not attributed to the formatter. No scaling, pool-size or hosting configuration changed.

## Bundles

Total generated JS: 1,398,408 -> 1,398,636 bytes (sum of individually gzipped chunks 418,559 -> 418,656 bytes) before the final scanner callback fix. Sales chunk: 54,872 -> 55,100 bytes; gzip 15,861 -> 15,947 bytes. Main entry remained 367,778 bytes. This change is CPU optimization, not bundle reduction. Final build sizes are recorded separately below when available. Route lazy loading and existing chart splitting remain intact.

## Regression / security verification

- Frontend full standalone suite after scanner fix: 245 passed, zero failures/skips.
- Targeted POS/map/search/barcode/checkout suite before final scanner change: 36 passed; final held-cart/scanner integration: 16 passed.
- Backend standalone suite: 637 total, 590 passed, 47 DB-only skipped; syntax 137 JS modules passed.
- Disposable POS/AI/database/HTTP suite: 117 passed, zero failures/skips; billing/resource/subscription/release suite: 45 passed, zero failures/skips.
- Actual SQL/HTTP regressions cover exact payment/replay, refund, fractional receipt, customer debt allocation, stock locking, concurrent writes, tenant/branch scope, RBAC, subscriptions, AI accounting/actions/conversation behavior. No security guard removed.
- Production-build browser at 390/768/1366/1920: 20 consecutive scan events produce 5 cart lines of quantity 4, no dropped scans; scanner modal opens; zero page errors. Synthetic events do not certify physical camera/scanner hardware.
- Existing AI browser acceptance: 28 light/dark viewport/mode cases passed, delayed responses, confirmation/reset controls, composer, focus/inert and Sales/launcher separation; zero page errors. This does not measure OpenAI quality or API latency.
- Design baseline: all 23 CSS/SCSS matched. Import audit: 123 source files, zero missing imports/brace errors/forbidden refs. Production readiness: passed, 124 files. Local production builds passed.
- Independent code review found no blocking correctness/security issue, including scanner dependency fix.

Early verification attempts encountered sandbox subprocess restrictions; reruns with approved subprocess access passed. An initial concurrent DB invocation collided with the migration test's schema reset; the final DB suite ran serially. These early failures are not counted as passes.

## Remaining platform coverage / release gates

| Area | Current evidence | Remaining work |
|---|---|---|
| POS | search, scanner, cart CPU and business regression tests | timed server-confirmed checkout P50/P95/P99, physical scanner/printing, all payment modes under sustained concurrent load |
| Navigation, login, sidebar/topbar | route lazy loading already exists; unchanged | instrument visual feedback/usable-UI timings, first load, login dashboard and every navigation/control |
| Products / inventory / warehouses | catalog scale read samples, stock/receipt/branch regression tests | populated 50k warehouse balances, transfers, movement history, rare-query plans, scroll/memory soak, pagination adoption in legacy consumers |
| Dashboard / analytics | existing lazy route/chart chunks preserved | React per-component render counts, widget aggregation and chart profiles, date-range benchmarks |
| Customers / suppliers / expenses / history | existing regression suites; no new latency claim | real-shaped module datasets and measured filter/search/save/export flows |
| Settings / staff / billing / branches | billing/RBAC/subscription regressions passed | timed controls, account/branch/permission cache invalidation browser scenarios |
| AI | UI delayed-response and security/database regressions passed | real OpenAI synthetic smoke, 40-question quality review inherited from #11/#19, first feedback/full-response/token/tool metrics, streaming validation |
| Mobile | synthetic 390px / 4x CPU and larger layouts | 360px performance, real Android/network throttle, keyboard/touch/scroll/long-task and memory soak |
| Render / Neon | no production writes/load/config changes | read-only hosting CPU/memory/cold-start/queue/pool evidence and region-aware staging benchmarks |
| Monitoring / CI | existing slow/error request telemetry retained; no sensitive payload logging added | bounded P50/P95 aggregation, query/acquisition metrics, CI performance budgets and remote CI result review |

Caching remains existing request deduplication/mutation generations and workspace refresh behavior. This tranche adds no financial/permission/subscription response cache. No unverified AI facts are streamed. Server confirmation, RBAC, tenant isolation, transactions, audit and idempotency remain authoritative.

Do not release on these local numbers alone: resolve AI draft gates, review both stacked PRs, verify CI, exercise realistic staging data/network/cold starts, complete remaining P0/P1/P2 scenarios, and obtain explicit authorization for any production release/migration.

## Reproduction

Run scripts from their respective repository roots. Frontend: node scripts/benchmark-catalog.mjs [--optimized]; node scripts/benchmark-cart.mjs [--optimized]; node tests/performance.browser.mjs --production [--baseline]. For baseline scripts set GIT_EXECUTABLE if Git is not on PATH; PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH can point at an installed Chromium.

Backend: node scripts/benchmark-bootstrap-dates.mjs [--optimized]; NODE_ENV=test with identical DATABASE_URL and TEST_DATABASE_URL pointing to a migrated disposable loopback database, then node scripts/benchmark-read-api.mjs [--baseline] [--bootstrap-only]. Safety gate rejects Neon/remote/production-looking targets. Fixtures remain until the disposable container is removed. Do not point these commands at production.

Raw local evidence: artifacts/performance-20261016 at the shared workspace root. GitHub PR links and remote CI status are appended after creation.

Final scanner-fix build: total JS 1398689 bytes; sum of gzip chunks 418627 bytes; Sales chunk 55153 bytes (15960 gzip).
