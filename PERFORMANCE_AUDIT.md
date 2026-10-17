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

The continuation results below supersede the original remaining-work table and earlier CI status. Historical measurements above are retained as their original cohorts.

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

## GitHub handoff / remote checks

Frontend draft PR: https://github.com/Wamwod10/Zenix-Pos/pull/20 (perf/catalog-search-20261016).

Backend draft PR: https://github.com/Wamwod10/Zenix-Pos-Backend/pull/12 (perf/read-latency-20261016).

Both PRs target feature/ai-intelligence-2 to preserve AI #19 / #11. Retarget after those PRs merge. Runtime commits: frontend 0a56c87b20ae971aa3db8cf619abdc3ce0e60ad9; backend 7eafd49e6a294478ebb355878ec362d11d4f6fc1. Runtime changes and audit notes are pushed.

The connector lacked PR-write permission. Following explicit user authorization, the existing Git authentication was used only to check/create these two draft PRs. Credentials were kept in memory and never printed or saved.

Remote Actions API previously returned no workflow runs for the runtime commits; green GitHub CI is not confirmed. Local test evidence is recorded above. Frontend feature-branch preview status was success. No production promotion, merge or deployment command was run; preview automation was not changed.

## Continuation: P0/P1/P2, 2026-10-16

Environment: Windows, Node 24.11.1, local Chromium, PostgreSQL 16 Alpine in an isolated loopback Docker container. Only synthetic fixtures and disposable DB migrations were used. Percentiles are nearest-rank observations, not production guarantees. CPU microbenchmarks, server-confirmed HTTP, first DOM mutation and React commit duration are different measurements. Root evidence: `artifacts/performance-continuation-20261016/`. No production write, migration, configuration change, merge or deployment was performed.

### Measured bottlenecks and changes

| Module | Operation | Before P50 | Before P95 | After P50 | After P95 | Improvement | Test Environment | Status |
|---|---|---:|---:|---:|---:|---|---|---|
| Entitlements | Unlimited capacity assertion, 50k products | 6.710 | 16.232 | 0.693 | 0.891 | 94.5% P95 | rollback-only disposable SQL, 50 samples | improved; migration review required |
| Import | 100 product inserts at 50k | 572.422 | 728.249 | 23.710 | 30.415 | 95.8% P95 | disposable SQL/savepoints, 10 samples | improved; finite caps preserved |
| Inventory | Owner catalog page, populated balances | 265.23 | 317.04 | 9.09 | 28.58 | 91.0% P95 | authenticated HTTP, 50k products / 100k balances, 30 samples | improved; index review required |
| Inventory | 100 concurrent readers | — | 7652.4 | — | 177.01 | 97.7% P95 | bounded 10-second stage, local client/server | improved; not hosting capacity certification |
| Analytics | 10k business-date records period filter CPU | 596.756 | 825.461 | 0.342 | 0.455 | 99.9% P95 | Node, 30 samples | improved |
| AI overview | Report read orchestration | 279.751 | 282.743 | 155.205 | 156.893 | 44.5% adapter P95 | synthetic delayed query adapter, 30 samples | query count improved; not OpenAI latency |
| POS | 1366px 50k search, trial 1 | 17.1 | 32.3 | 9.6 | 15.5 | 52.0% P95 | production browser, 30 samples per trial | improved |
| POS | Same search, trial 2 | 13.2 | 21.0 | 8.3 | 14.9 | 29.0% P95 | same browser/environment | improved |
| POS | Same search, trial 3 | 11.5 | 15.0 | 7.6 | 12.3 | 18.0% P95 | same browser/environment | improved; prior small regression not reproduced |
| Bootstrap | 50k full response, identity versus gzip | 1165.82 | 1384.57 | 1286.91 | 1623.52 | wire bytes -91.4%; local P95 +17.3% | alternating 30+30 HTTP/decode/parse samples | payload improved; initial load unresolved |
| AI/OpenAI | Live full-response latency | — | — | — | — | not measured | no local OpenAI key | remaining |

P99 before→after (ms): unlimited capacity 26.784→0.942; 100 inserts 728.249→30.415 (only 10 observations); populated catalog 973.15→32.80; Analytics 10k CPU 888.458→0.824; AI query adapter 297.282→157.418; repeated search trials 48.7→18.4, 22.1→15.3, 15.1→13.2; paired bootstrap identity/gzip 1392.29→1809.17. Retained earlier noisy gzip cohort ran alongside frontend tests and is not used to claim improvement.

Technical causes and changed code:

- `migrations/038_resource_capacity_performance.sql`: every Premium product insertion previously counted all existing products even for an unlimited cap. Capacity-only checks now skip usage counts only for unlimited resources; the public two-argument entitlement function still computes exact usage. Finite caps, scheduled downgrade evaluation, organization lock, subscription validation and legacy behavior remain. Historical migrations are untouched; lock timeout and rollback preparation are included.
- `migrations/039_inventory_catalog_lookup_index.sql`: the owner catalog stock subquery scanned 100k balances once for each visible product. The `(organization_id, product_id, store_id)` index changes the measured plan from 68,085 to 257 shared hits; execution 219.333→0.715 ms. Concurrent creation, invalid-index recovery and rollback notes included. This adds storage and write maintenance; no claim of zero write cost. Production migration requires review and operational scheduling.
- `src/services/aiReports.js`, `aiReadReports.js`: one business overview now reuses a private, callback-scoped organization/store/day snapshot. Topic RBAC remains checked on each component; tenant/session context cannot be supplied by callers. Query count 18→10 and organization reads 7→3. No cross-request cache, financial fact streaming or write-tool authorization change.
- `src/lib/bootstrapResponse.js`, `routes/bootstrap.js`: bounded asynchronous gzip for large read-only bootstrap responses (level 1, max two concurrent compressions, max 32 MiB). Negotiation, `Vary`, Express JSON settings and exact financial strings preserved. Same 23,436,490 decoded bytes became 2,008,594 wire bytes. Local CPU/decode cost increased; full-catalog JSON serialization, browser parsing and memory remain open. No omitted inventory, financial or permission fields.
- Frontend `analytics/analyticsPeriod.js`, `Analytics.jsx`: reuse the already-computed date range rather than rebuild timezone formatters/range per record. At 1k records CPU P50/P95/P99 47.726/65.782/83.784→0.045/0.139/0.562 ms. Timestamp-only records retain their existing timezone work; no finance math changed.
- Frontend `ai/aiScroll.js`, `ZenixAI.jsx`: defer scroll measurements into a cancellable animation frame and respect intervening user scrolling. Matched mobile trace launch-window layout total 163.165→43.5 ms, largest layout 118.64→7.2 ms; send layout 40.396→17.7 ms. This reduces forced-layout work but does not establish a consistent mobile feedback-tail win: 360px send P95 regressed 127.9→549.2 ms in the final cohort, while 390px was 218.4→214.9 ms. Sub-100ms mobile acceptance remains open.

### Checkout correctness and latency

Actual authenticated HTTP with three payment modes, refunds, three bursts each of 10/50 simultaneous sales, and ten concurrent identical references. Each cohort asserts exact stock, cash/card totals, returned amounts and tenant isolation: 274 unique sales, 90 refunds, final stock 9816; ten duplicate requests create exactly one sale. These are two observations of existing checkout behavior with diagnostics added, not a checkout rewrite or proven speedup.

| Operation | Before P50/P95/P99 ms | After P50/P95/P99 ms |
|---|---|---|
| Cash checkout | 96.16 / 132.28 / 230.55 | 101.22 / 133.34 / 136.29 |
| Card checkout | 49.93 / 130.61 / 150.03 | 67.08 / 129.02 / 129.92 |
| Mixed checkout | 68.97 / 127.48 / 134.35 | 88.68 / 131.74 / 135.98 |
| Cash refund | 110.33 / 153.50 / 157.29 | 124.58 / 147.22 / 183.01 |
| Card refund | 48.74 / 135.18 / 212.82 | 82.88 / 131.89 / 134.96 |
| Mixed refund | 65.99 / 145.55 / 150.51 | 89.32 / 147.67 / 182.85 |
| Concurrent 10, n=30 | 522.32 / 1027.11 / 1135.77 | 435.73 / 941.40 / 1053.55 |
| Concurrent 50, n=150 | 2139.98 / 3776.75 / 4048.88 | 2073.54 / 3842.67 / 4082.58 |

One hot product/shift serializes valid stock/payment work, with pool max five and up to 88 queued acquisitions. Locks and transactions were retained for correctness; sustained multi-terminal throughput and physical receipt printing remain staging/device gates. Existing 20-scan browser assertions passed in all three optimized repeated trials; old AI-base baseline skips that assertion because it contains the previously fixed stale scanner callback.

### Populated inventory, load and resource observations

Fixture includes two branches, 50k products, 100k inventory balances, 100k warehouse balances, 100k movements and 1k synthetic sales. All entitlement/security guards remained enabled. Baseline versus index stages at 1/10/50/100 concurrent readers: P95 286.7/636.9/5371.5/7652.4→18.74/22.65/92.89/177.01 ms; throughput 4.13/18.16/11.78/13.08→87.16/580.65/639.67/652.41 requests/s. Zero errors. Acquisition P95 at 100 readers 6541.3→91.81 ms. Each stage lasted ten seconds, not a prolonged soak. Optimized process RSS reached 718 MB including local load client; higher throughput is not a memory reduction or proof that the 512 MB Render plan can sustain this load. Rare/no-match/barcode catalog SQL still scans the product OR/substring predicate, around 60–110 ms locally. No speculative text-search index was added.

Render `My Workspace` read-only observation, Frankfurt production plan `0.5c-512mb`: 61 samples 15:15–16:15 UTC. Memory 171,331,580–190,414,850 bytes; CPU 0.00015585–0.0011625167 in the provider's reported `cpu` units. No HTTP latency samples returned. This quiet window cannot establish peak capacity, cold-start duration, Neon network latency or queue saturation. Staging requires a dedicated access token and database allowlist; no credentials were extracted or production load generated.

### Platform, monitoring, budgets and regression verification

Static interaction inventory records 725 lexical candidates across page/shared components with file/line references. This is an inventory, not certification of every save/edit/delete/export action. Browser coverage visits 15 owner routes at 360/390/768/1366/1920px, with mobile 4x CPU and throttled local assets; synthetic APIs, external origins blocked. First DOM mutation can be a skeleton rather than usable UI or physical paint. Root commit counts, long tasks and sampled heap are retained; real Android keyboard, touch, long scrolling and memory soak remain open.

Opt-in `ZENIX_PERFORMANCE_METRICS=true` adds bounded recent-window P50/P95/P99 for fixed HTTP module labels, DB acquisition/query and transaction duration. Disabled by default; no production setting changed, no public diagnostics endpoint added. At most 128 series and 256 recent samples by default; lifetime count/failures and window sample count are distinguished. No SQL, tokens, request payloads, customer identifiers or sale details are logged by these metrics.

CI adds CPU regression budgets (50k search P95 <100ms, indexed cart <5ms, 10k date filter <50ms), main gzip <130,000 bytes, all JS gzip <470,000 bytes, and isolated checkout correctness with sequential P95 <1500ms. These broad guards detect major regressions; they are not production UX SLAs. Final local bundle: main gzip 113,658 bytes; all JS gzip 418,802 bytes. This is not a bundle reduction claim.

- Frontend full suite: 250/250 passed, zero skips/failures. Existing AI browser acceptance: 28 light/dark cases passed. All 23 CSS/SCSS match baseline. Import/readiness checks and production build passed.
- Backend standalone: 599 passed, 49 DB-only skipped (648 total); syntax 145 modules passed. Serialized disposable DB/HTTP/billing/subscription/RBAC/AI/checkout suite with diagnostics enabled: 176/176 passed, zero skips/failures. New compression HTTP negotiation, exact JSON, bounded concurrency, finite/unlimited capacity, query-snapshot authorization, populated stock index and telemetry privacy tests passed.
- Early sandbox subprocess failures and a missing JSDOM animation-frame cancellation fixture were corrected and rerun; failed attempts are not counted as passing evidence. No financial rounding, authorization, audit, transaction, branch isolation, confirmation or idempotency guard was removed.

Component profiling: production React profiling renderer, 1366px/1x CPU, 1k and 10k synthetic sales/products, eight period selections each, zero browser errors. At 10k, Dashboard/Analytics each entered four renders per selection; page subtree commit actualDuration P50/P95 was 1.50/17.30 ms and 1.10/16.80 ms. Chart function entries were four/nine per selection. These include descendants and profiling overhead; current-code observations only, no before/after UI claim. Raw initial and per-commit samples: dashboard-render-results.json.

### Remaining platform coverage: current status

| Area | Status | Completed evidence | Remaining release gate |
|---|---|---|---|
| POS / checkout | partial | real cash/card/mixed/refund percentiles, 10/50 bursts, duplicate replay, repeated barcode assertions | physical scanner/printer; sustained realistic terminal workload; hot-row tail latency |
| Navigation / controls | partial | 15 owner routes, 5 widths, static interaction inventory | authenticated real login-to-usable dashboard; every topbar/modal/control action and branch cache scenario |
| Catalog / inventory | partial | 1k/10k/50k search and capacity tests; populated multi-branch balances/movements, query plans, bounded load | full 50k bootstrap/hydration/memory; long scrolling; realistic transfer/import workloads; index write-cost evaluation |
| Dashboard / analytics | partial | date-filter CPU bottleneck fixed; profiling harness added | production-shaped widget/chart/API timings and physical-device profiles |
| Customers / suppliers / expenses / history | partial | route availability and business regressions | large real-shaped per-module search/filter/save/export latency |
| Settings / staff / billing / branches / Telegram | partial | route inventory, billing/RBAC/subscription regressions | timed per-control operations and browser permission/subscription/branch invalidation scenarios |
| AI | partial | report queries 18→10, scroll layout reduced, 28 UI acceptance cases and security regressions | real OpenAI full-response/token/quality eval; consistent mobile <100ms feedback; safe streaming validation |
| Mobile | partial | 360/390/768/1366/1920 synthetic Chromium, CPU/network/trace observations | real Android/touch/keyboard; long scroll/memory soak; observed mobile feedback tail |
| Render / Neon | partial | existing Render CPU/memory read only; local pool/query metrics | authorized staging/cold-start/network separation, real Neon plans and hosting throughput |
| Monitoring / CI | partial | bounded opt-in diagnostics, CPU/bundle/checkout budgets, local full verification | deployment-time metrics collection decision; ongoing production observation |

Merge order remains AI backend #11 / frontend #19 before performance backend #12 / frontend #20 (currently stacked on AI branches). Both new migrations require separate review before any production execution. Live OpenAI benchmarking requires a dedicated test key; device and staging gates must not be marked complete from mocks. No independent production release is authorized.

### Continuation GitHub verification

Both tested runtime heads passed GitHub Actions:

- Frontend `52d2f3fabaf61d5f99cad0438476d78d9e50e56f`: [Verify Frontend run 38932104719](https://github.com/Wamwod10/Zenix-Pos/actions/runs/38932104719), success; full suite, design/import/readiness, build, CPU/bundle budgets and responsive login smoke.
- Backend `4a63bec4fe2a1232c27df6b211e77387e26cb334`: [Verify Backend run 38932097986](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/38932097986), success; standalone and isolated DB/HTTP, trial/OTP, billing/AI, new index/capacity tests, checkout budget, legacy migration and backup/restore verification.

These results supersede the earlier unconfirmed CI note. Existing PR #20/#12 were updated by pushing to their original branches; AI bases remain ancestors. This final report update changes documentation only. The named disposable PostgreSQL container was stopped after evidence capture; raw local JSON/traces remain in the workspace artifact directory.
## Final optimization verification — 2026-10-17

This section supersedes earlier completion counts and remaining-coverage labels. Production release is **BLOCKED** by staging, real-provider/device validation and unresolved large-snapshot/mobile tails. Historical observations above remain historical; no production load, deployment or migration was performed.

### Shipped changes and controlled measurements

- `backend/src/routes/bootstrap.js`: aggregate tenant/branch stock once before joining products. All product columns, complete inventory, last-sale data and authorization remain. Full-row comparisons passed for 50,000 products, owner and both branches; rollback-only fixtures cover missing/zero/negative/decimal balances and custom metadata. A real-route PostgreSQL regression is included in CI.
- `frontend/src/utils/bootstrapInventory.js` and `StoreContext.jsx`: yield during complete inventory normalization with a time budget, cancel stale generations and publish only the complete authorized snapshot. JSON parsing remains synchronous. No fields are dropped; no cross-tenant cache is added.
- `frontend/src/pages/ai/ZenixAI.jsx`: memoize unchanged answer/report content; live confirmation cards remain outside the memoized subtree. Existing layout/classes and security checks remain.
- Backend `performanceTimer.js`, `aiAgentChat.js`, `aiAgentRegistry.js`, `bootstrapResponse.js`: opt-in fixed-label phase timing using the existing bounded metrics store. No prompts, SQL, identifiers, tokens or financial payloads enter these metrics. Disabled mode executes work directly.

| Module | Operation | Before P50 | Before P95 | After P50 | After P95 | Improvement | Test Environment | Status |
|---|---|---:|---:|---:|---:|---|---|---|
| Bootstrap SQL | Owner full result | 483.09 | 530.36 | 424.43 | 483.62 | P95 -8.8% | Local PG16, 50k products/100k balances, 8 alternating samples | COMPLETED |
| Bootstrap SQL | Locked branch full result | 427.86 | 502.20 | 393.85 | 454.56 | P95 -9.5% | Same local PG | COMPLETED |
| Bootstrap HTTP | Complete authenticated snapshot | 1088.40 | 1267.57 | 1106.47 | 1201.93 | P95 -5.2%; P50 +1.7% | Same gzip/full data, 30 alternating samples per version | PARTIALLY COMPLETED |
| AI UI | Mobile send DOM feedback | 144.4 | 187.8 | 67.2 | 102.9 | P95 -45.2%; 100ms target still missed | 390px, Chromium 4x CPU, 20 samples | PARTIALLY COMPLETED |
| AI UI | Mobile verified mock reply rendered | 683.6 | 1399.1 | 515.7 | 570.3 | P95 -59.2% | Same, fixed 350ms synthetic response | COMPLETED |
| AI UI | Mobile mode switch, two RAF | 474.9 | 1051.2 | 318.0 | 541.7 | P95 -48.5%; tail remains | Same | PARTIALLY COMPLETED |

All values above are milliseconds. SQL n=8 P99 equals observed maximum/P95, not a stable production tail estimate. Engine execution owner P50/P95 205.98/215.85→173.20/175.40ms; branch 162.37/176.45→129.38/130.67ms. Full HTTP P99 1293.80→1212.35ms. Identical JSON length 23,294,729 bytes; median gzip bytes 1,990,408→1,994,513 (equal-timestamp ordering affects compression). HTTP-side JSON parse P50/P95/P99 84.43/121.85/122.60→84.42/125.78/129.57ms: no parsing win. Sampled Node RSS maximum 523,415,552→522,743,808 bytes includes the benchmark client/buffers; this does not establish memory savings or fitness for the 512MB production service. Gzip P95 139.49→155.56ms remains a CPU/tail cost. Evidence: `artifacts/performance-final-20261016/bootstrap-products-sql.json`, `bootstrap-sql-http.json`.

A negotiated columnar snapshot and worker parsing/normalization were implemented and measured experimentally, then **rejected and removed** because transfer/reconstruction increased mobile usable-UI tails. Archived `rejected-worker-source` and experiment JSON files are not shipped code or release evidence. The shipped protocol remains the existing complete JSON response. Progressive server pagination requires a separate, correctness-preserving POS architecture change; it is not silently substituted here.

AI mobile send P99 250.5→110.8ms; reply P99 1637.9→608.5ms; mode P99 1093.4→707.7ms. Long-history typing P50/P95/P99 60.6/141.2/208.3→43.2/124.9/163.3ms. Cold launch was a single ~803ms DOM/~963ms two-RAF observation, not a percentile or proof of instant launch. Two additional 20-sample desktop pairs did not reproduce the original mode P95 regression: 46.9→42.2ms and 63.9→44.4ms; P99 slightly worsened 84.9→85.8 and 71.9→73.8ms. No universal tail-win claim. Evidence: `artifacts/performance-continuation-20261016/ai-interaction-tails`.

Current-only AI backend phase observations use real local PostgreSQL and a scripted 10ms provider, **not OpenAI**: verified report n=30 total P50/P95/P99 382.86/451.88/512.82ms; fallback n=10 430.35/512.55/512.55ms. Report phase P50/P95 58.05/71.87ms, tool 82.88/98.09, evidence 0.78/1.36, memory 0.06/0.15, validation 0.07/0.15. Provider phase includes dispatch/quota DB overhead and is not external model latency. Synthetic token counters are not tokenizer measurements. Evidence: `ai-backend-phases.json`. Live OpenAI key was absent; no credentials were obtained or production quota consumed.

### Controls and migration security review

`tests/finalControls.browser.mjs` passed 45 concrete checks across 15 modules with synthetic pending/error responses and zero external requests. Coverage includes catalog/inventory/customer/supplier/expense/staff dropdowns, search/columns/modals, settings branch/staff tabs, CRM pending/error/retry/edit, AI pending/reply and billing menus. This is not all 725 lexical interaction candidates: destructive actions, real persistence, exports/printing and every permission/branch transition remain partial. Single interaction observations include automation overhead and are not P95 or physical-paint guarantees.

Migrations 038/039 remain unchanged and **REQUIRE PRODUCTION APPROVAL**. Disposable tests verified finite Business caps, unlimited Premium, concurrent capacity enforcement, downgrade/full usage behavior, security-invoker functions and unprivileged-role denial (42501), rollback/reapply, and the runner's nontransactional concurrent-index path. The new index complements existing store-leading keys. On 100k balances its size was 6,864,896 bytes; concurrent build 282.70ms, an independent insert 4.01ms while build waited on a virtual transaction lock. Ten batches of 500 inserts had P50/P95 318.89/385.37ms before and 280.65/367.83ms after; cache/noise prevents a write-overhead or speedup conclusion. Large production-table duration, IO, lock wait and disk headroom still require an approved rollout window. Evidence scripts: `final-migrations-safety.mjs`, `final-bootstrap-products-sql.mjs`.

### Final browser snapshot observations

Identical captured 50k JSON, exact prior StoreContext versus current production React app, alternating cohorts after two warmups, six observations per mode/width. At this small n, P95=P99=observed maximum. Desktop's first observations overlapped a short backend unit run; do not interpret noisy small differences as stable speedups. Network APIs are intercepted, so these usable times exclude real backend/network latency.

| Operation | Before P50/P95/P99 ms | After P50/P95/P99 ms | Status |
|---|---|---|---|
| 1366px usable POS | 1329.1/1351.1/1351.1 | 1261.2/1440.7/1440.7 | PARTIALLY COMPLETED; tail worse |
| 390px 4x usable POS | 4871.8/5358.1/5358.1 | 4940.7/5413.5/5413.5 | PARTIALLY COMPLETED; no overall win |
| 390px complete snapshot ready | 3297.6/3989.5/3989.5 | 3209.7/3476.9/3476.9 | PARTIALLY COMPLETED |
| 390px longest normalization slice | 166.3/248.9/248.9 | 12.3/30.1/30.1 | COMPLETED; reduced normalization blocking |
| 390px JSON parse | 502.2/670.8/670.8 | 517.6/663.1/663.1 | PARTIALLY COMPLETED; still blocking |
| 1366px JSON parse | 36.7/51.2/51.2 | 35.5/48.4/48.4 | PARTIALLY COMPLETED |

Observed 250ms-sampled renderer JS heap maximum: desktop 50,719,012→50,452,120 bytes; mobile 61,272,340→61,575,416. This excludes worker/native/whole-browser memory and does not establish peak RAM reduction. Mobile longest task P95 756→778ms and total long-task P95 3596→3813ms show remaining parse/render bottlenecks. All 50k products remained present; last SKU search/cart add passed, zero page errors. Cooperative normalization ships for bounded individual work slices and stale safety, not an overall bootstrap latency claim. Evidence: `bootstrap-cooperative-browser.json`.

### Remaining platform coverage — final status

| Area | Status | Verified scope / remaining gate |
|---|---|---|
| POS/checkout | PARTIALLY COMPLETED | Cash/card/mixed/refunds, duplicate and 10/50 bursts; physical receipt/scanner and sustained terminal load remain. |
| Navigation/controls | PARTIALLY COMPLETED | 15 routes, responsive browser coverage, 45 concrete control checks; not every destructive/export/branch transition. |
| Catalog/inventory | PARTIALLY COMPLETED | Full-row 50k SQL parity and bounded normalization; 23.3MB parse/render and long-scroll/real imports remain. |
| Dashboard/analytics | PARTIALLY COMPLETED | CPU bottleneck fixed and current render profile captured; production-shaped widget timings remain. |
| Customers/suppliers/expenses/history | PARTIALLY COMPLETED | Synthetic route/control and business regressions; large persistence/export latency remains. |
| Settings/staff/billing/branches/Telegram | PARTIALLY COMPLETED | Billing/RBAC suites and selected controls; exhaustive invalidation and integration scenarios remain. |
| AI report rendering/phase diagnostics | COMPLETED | Targeted memo regression, paired UI measurements, fixed-label phase tests; this scope does not include real provider latency. |
| AI overall mobile latency | PARTIALLY COMPLETED | Send/report improved; cold launch/mode/input tails still miss targets. |
| Live OpenAI benchmark | BLOCKED | No authorized test key; operator-provided dedicated synthetic quota required. |
| Android/printer/scanner | REQUIRES REAL DEVICE | Desktop Chromium emulation is not hardware certification. |
| Hosting/cold start/sustained load | REQUIRES STAGING | Staging token/DB isolation not established; production excluded. |
| Migrations 038/039 | REQUIRES PRODUCTION APPROVAL | Disposable safety/security/rollback/concurrent-index tests completed; execution remains separately approved. |
| Monitoring/CI | PARTIALLY COMPLETED | Bounded optional phase/HTTP/DB metrics and regression budgets; production collection policy/observation remains. |

Final local production POS browser passed at 390/768/1366/1920px: every width retained all 20 scanner inputs as five cart lines, quantity four each, zero browser errors. Search P50/P95/P99 ms respectively 47.0/126.4/150.8, 8.4/14.5/14.8, 11.0/16.1/16.2, 8.3/13.3/13.5. API intercepted, mobile 4x CPU; this was a functional regression run overlapping disposable DB tests, not an isolated before/after latency claim. Evidence: `artifacts/performance-final-pos-browser.log`.

### Final local quality gate

- Frontend full suite **253/253**, no failures/skips; backend standalone **600 passed, 50 DB-only skipped** (650 total), syntax **150 modules**.
- Disposable PG/HTTP/billing/subscription/tenant/branch/checkout/AI evidence/confirmation/security: **166/166** passed with diagnostics enabled; additional trial/OTP security **12/12** passed, no skips. These are separate serialized runs (178 passing cases total), not 178 standalone unit tests.
- Existing AI Chromium **28/28** cases, new representative controls **45 checks**, final four-width POS/barcode assertions passed. Design/import/readiness/build/CPU/bundle gates passed. Main gzip **113,908**, total JS gzip **419,053** bytes.
- Final checkout current-only revalidation: cash P50/P95/P99 **78.06/130.38/132.08ms**, card **111.73/130.66/131.55**, mixed **67.48/130.62/132.16**; refund cash **125.48/150.40/151.27**, card **116.55/136.47/142.76**, mixed **108.21/153.60/159.79**. Ten-user burst **554.18/1061.21/1135.24**, fifty-user **1872.96/3804.31/4507.89**. Exact 274 sales/90 refunds/9816 stock, cash 12960/card 14440, duplicate replay and tenant isolation passed. Pool max five, peak waiting 78; transactions/locks retained. No checkout-speedup claim from this current-only repeat.
- `benchmark-ai-phases.mjs` reran successfully with process exit 0 using a local scripted provider and actual DB; this still does not validate real OpenAI.
- Logs: `artifacts/performance-final-db.log`, `performance-final-trial.log`, `performance-final-checkout.log`, `performance-final-ai-phases.log`, frontend `.cache/performance/final-full-tests.log`, backend `performance-final-tests.log`.

Push/CI: both final runtime heads passed; exact run links follow. Historical green heads above do not certify later commits. PR metadata editing is unavailable (connector 403); committed audit/readiness reports provide the reviewable update instead. No credential extraction was attempted.

### Final runtime GitHub verification

- Frontend `3c05aff303395b0a138d41f4ca1f5277048067ee`: [Verify Frontend 39022937418](https://github.com/Wamwod10/Zenix-Pos/actions/runs/39022937418), **success**.
- Backend `3892e96223aab4b29d8a0a573b6f51f02d68f30c`: [Verify Backend 39023031810](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/39023031810), **success**, including isolated DB, billing/AI, checkout budget, legacy migration and backup/restore.

Both existing performance branches were pushed; AI base commits remain ancestors. The follow-up report synchronization changes documentation only. Check the branch-tip workflow as well before release. Disposable container `zenix-perf-final-20261017` was verified loopback-only and stopped after all tests. No production resources were modified. Overall release status remains **BLOCKED** for the explicit staging/provider/device and large-snapshot/mobile gates in `RELEASE_READINESS.md`.


## 2026-10-17 progressive POS and mobile AI continuation ? supersedes earlier remaining gates

**Release status: BLOCKED.** This section records new working-branch code and fresh local evidence; historical tables above remain historical. No production database, deployment setting, migration, sale or AI quota was changed. Frontend baseline: 6548e80; backend baseline: 8fb0360. Existing AI #11/#19 ancestry and performance #12/#20 branches retained.

### Architecture and dependency audit

The complete bootstrap coupled every initial route to product rows, all scoped serial/batch arrays, JSON serialization, compression, parse and normalization. Compression reduced transfer bytes but retained the expensive full parse. The new architecture chooses **opt-in core bootstrap + branch-scoped keyset catalog + bounded POS detail cache**. It removes full-catalog dependency from initial Dashboard/POS instead of moving the same huge parse to another thread. Financial write APIs, transactions, arithmetic, subscription checks and audit are unchanged.

| Consumer | Initial data / completeness rule |
| --- | --- |
| Login/layout | Existing identity, organization, branches, settings, permissions and financial core remain; x-zenix-bootstrap:core skips product/serial/batch queries. Vary distinguishes representations; existing API no-store remains. |
| Dashboard | Finance widgets use existing core/reports; inventory-derived totals show unknown/not-loaded, never false zero or no-alert. Full inventory is explicitly requested for stock inspection. |
| POS | First 40 active products; later search/barcode/details use tenant + requested branch endpoint. Full product metadata, pricing, packaging/units, variants and scoped tracking are retained. |
| Drafts/holds/refunds | Persisted draft IDs resolve before mounting cashier; held/refund IDs resolve before reconciliation. Explicit missingIds differs from network failure. Existing idempotent server confirmation remains mandatory. |
| Products/inventory/suppliers/analytics/history/settings | Legacy consumers require complete full snapshot before rendering. Existing endpoint without header is backward compatible. This still has large-snapshot cost when explicitly opened. |
| Other independent routes | Existing core data/API patterns retained; no unrelated module rewrite. |

Backend: src/routes/bootstrap.js, new src/lib/posCatalog.js and src/services/posCatalog.js. Catalog queries validate mode, limit <=100, ids <=100 and branch scope before data access; microsecond timestamp + UUID cursor gives deterministic ordering. Browse excludes archived products; explicit IDs retain archived recovery context. Ambiguous barcode fails closed. Requested branch stock is authoritative, including explicit database zero. No new SQL migration.

Frontend: src/context/StoreContext.jsx, new PosWorkspace.jsx and utils/posCatalog.js; App.jsx guards legacy consumers. Sales.jsx uses bounded remote results and queued scanner reads; MainLayout.jsx and Dashboard.jsx guard incomplete aggregates. Cache target 600 details, protected cart/recent IDs, visible page window <=200; cart resolution limit 250. Repeated pages/resolutions deduplicate; stale/out-of-order responses cannot publish across search generations or tenant/user/role/branch scope. StrictMode replay is supported. Completing an outer full snapshot does not remount/reset active remote cashier. Unknown/missing stock throws rather than becoming zero. Draft intent flushes on branch/unmount, while confirmed checkout does not resurrect a cleared cart. Hold/refund locks are acquired before asynchronous lookups. Checkout still validates stock/prices/permissions on backend.

**Limits:** This is live keyset pagination, not an immutable database snapshot: concurrent newer inserts may appear on refresh; stock is rechecked at checkout. Catalog categories and per-product tracking children are not fully bounded; no silent truncation was introduced. Poor-network lookup fails with retry and retains draft; complete offline catalog support is not claimed. Existing cross-tab refresh protocol is retained; no new physical multiple-terminal/device certification.

### Equal-environment HTTP benchmarks

Local PostgreSQL16 disposable loopback :55436, Node24.11.1, authenticated synthetic Premium fixtures, two branches. 30 observations/group after three warmups, alternating legacy/core order. These measure full-response client latency, not isolated SQL time or Render/Neon latency. Richer 50k fixture is **32.75MB JSON**, unlike historical 23.3MB fixture; comparisons below use the same fresh fixture on both paths. P50 / P95 / P99 milliseconds.

| Products | Legacy full | Core initial | JSON bytes full ? core |
| --- | --- | --- | --- |
| 1000 | 75.2 / 95.2 / 100.3 | 37.0 / 56.2 / 60.6 | 656550 ? 1599 |
| 10000 | 212.1 / 280.4 / 308.6 | 22.8 / 61.0 / 71.8 | 6551552 ? 1601 |
| 50000 | 845.5 / 936.5 / 970.3 | 20.3 / 44.9 / 46.1 | 32751552 ? 1601 |

50k full gzip transfer median 2,091,361 bytes ? core 1,601 identity bytes. First catalog response median 30899 bytes; on-demand data is additional traffic, not eliminated. At50k, first-page API 20.8 / 28.5 / 28.9, unloaded-name search 95.9 / 126.6 / 160.2, exact barcode 20.8 / 35.6 / 37.3. All 495 HTTP assertions passed. RSS contains both server/client and retained snapshots in one process: no server peak-memory/capacity claim.

### Actual production React before/after browser benchmarks

Exact previous runtime files vs current runtime, captured disposable responses, APIs intercepted (no live network latency), two warmups + six alternating observations/group. 390px=4xCPU; 768/1366=1xCPU. Same explicit JSON.parse instrumentation. P95/P99 here are small-sample observed maxima, **not statistical guarantees**. DOM usable controls and FCP entries are measured; no physical paint/input/device claim.

| Products | Viewport | Cold POS before P50/P95/P99 | After P50/P95/P99 |
| --- | --- | --- | --- |
| 1000 | 390 | 2311.4 / 2718.1 / 2718.1 | 2767.0 / 3110.8 / 3110.8 |
| 1000 | 768 | 1026.2 / 1030.9 / 1030.9 | 1034.5 / 1059.0 / 1059.0 |
| 1000 | 1366 | 1074.3 / 1098.8 / 1098.8 | 1039.4 / 1058.1 / 1058.1 |
| 10000 | 390 | 3274.6 / 3731.4 / 3731.4 | 2670.2 / 3385.0 / 3385.0 |
| 10000 | 768 | 1091.4 / 1134.9 / 1134.9 | 979.8 / 1046.8 / 1046.8 |
| 10000 | 1366 | 1156.6 / 1168.8 / 1168.8 | 1041.5 / 1075.3 / 1075.3 |
| 50000 | 390 | 4388.2 / 4840.7 / 4840.7 | 2357.8 / 2786.2 / 2786.2 |
| 50000 | 768 | 1520.7 / 1583.7 / 1583.7 | 984.7 / 1064.3 / 1064.3 |
| 50000 | 1366 | 1504.0 / 1587.3 / 1587.3 | 1053.4 / 1093.2 / 1093.2 |

| 50k metric | Viewport | Before P50/P95/P99 | After P50/P95/P99 |
| --- | --- | --- | --- |
| parseTotalMs (ms) | 390 | 561.8 / 726.3 / 726.3 | 0.6 / 3.8 / 3.8 |
| blockingMs (ms) | 390 | 2162.0 / 2526.0 / 2526.0 | 612.0 / 768.0 / 768.0 |
| longMaxMs (ms) | 390 | 641.0 / 789.0 / 789.0 | 243.0 / 339.0 / 339.0 |
| heapObservedMax (bytes) | 390 | 58894732.0 / 74880996.0 / 74880996.0 | 6800572.0 / 7164840.0 / 7164840.0 |
| searchMs (ms) | 390 | 233.5 / 304.5 / 304.5 | 440.9 / 648.8 / 648.8 |
| fcpMs (ms) | 390 | 1288.0 / 1412.0 / 1412.0 | 1348.0 / 1400.0 / 1400.0 |
| parseTotalMs (ms) | 768 | 44.8 / 57.9 / 57.9 | 0.2 / 0.4 / 0.4 |
| blockingMs (ms) | 768 | 36.0 / 94.0 / 94.0 | 30.0 / 55.0 / 55.0 |
| longMaxMs (ms) | 768 | 86.0 / 124.0 / 124.0 | 80.0 / 105.0 / 105.0 |
| heapObservedMax (bytes) | 768 | 41254324.0 / 51446148.0 / 51446148.0 | 6241612.0 / 6833440.0 / 6833440.0 |
| searchMs (ms) | 768 | 59.0 / 66.2 / 66.2 | 258.2 / 295.0 / 295.0 |
| fcpMs (ms) | 768 | 176.0 / 208.0 / 208.0 | 164.0 / 200.0 / 200.0 |
| parseTotalMs (ms) | 1366 | 40.3 / 46.7 / 46.7 | 0.2 / 0.4 / 0.4 |
| blockingMs (ms) | 1366 | 10.0 / 34.0 / 34.0 | 15.0 / 61.0 / 61.0 |
| longMaxMs (ms) | 1366 | 60.0 / 84.0 / 84.0 | 65.0 / 111.0 / 111.0 |
| heapObservedMax (bytes) | 1366 | 41308452.0 / 51101820.0 / 51101820.0 | 6216144.0 / 6301432.0 / 6301432.0 |
| searchMs (ms) | 1366 | 58.4 / 64.1 / 64.1 | 273.0 / 286.2 / 286.2 |
| fcpMs (ms) | 1366 | 188.0 / 248.0 / 248.0 | 204.0 / 292.0 / 292.0 |

Blocking=sum(max(longTask-50ms,0)); heap is largest sampled main JS heap at250ms intervals through search/cart-add, not OS peak or a GC-normalized leak test. 50k mobile cold-POS P95 improves 42.4%; parse P95 726.3?3.8ms, blocking P95 2526?768ms. **1k mobile cold POS P95 regresses 2718.1?3110.8ms**; smaller catalogs do not benefit equally.

| 50k journey metric | Viewport | Before P50/P95/P99 | After P50/P95/P99 |
| --- | --- | --- | --- |
| dashboardMs | 390 | 4571.6 / 5524.6 / 5524.6 | 2739.8 / 3220.4 / 3220.4 |
| posUsableMs | 390 | 5520.4 / 6710.9 / 6710.9 | 3782.8 / 4428.4 / 4428.4 |
| navigationMs | 390 | 842.6 / 1183.3 / 1183.3 | 1064.1 / 1302.2 / 1302.2 |
| dashboardMs | 768 | 1415.0 / 1445.4 / 1445.4 | 956.7 / 996.3 / 996.3 |
| posUsableMs | 768 | 1551.9 / 1696.7 / 1696.7 | 1824.4 / 1899.3 / 1899.3 |
| navigationMs | 768 | 154.0 / 248.3 / 248.3 | 862.4 / 892.2 / 892.2 |
| dashboardMs | 1366 | 1398.1 / 1494.0 / 1494.0 | 959.9 / 981.6 / 981.6 |
| posUsableMs | 1366 | 1620.6 / 1661.1 / 1661.1 | 1823.9 / 1856.6 / 1856.6 |
| navigationMs | 1366 | 214.6 / 236.2 / 236.2 | 858.7 / 869.2 / 869.2 |

**Observed regressions remain open:** warm local search becomes debounced remote search; 50k mobile search P95 304.5?648.8ms and10k mobile reaches681ms, above600ms goal. Warm Dashboard?POS router navigation regresses, including desktop236.2?869.2ms; tablet total journey also regresses. Diagnostic1k desktop catalog resolves in13?30ms and Sales resources finish soon afterward, with remaining gap before visible controls; this does not establish a slow SQL cause. A POS-local Suspense experiment did not improve the gap and was reverted. Small-n variability is disclosed; no assertion that every interaction improved. Follow-up render/scheduling/visibility profiling and isolated staging are required before approving these regressions.

### AI mobile responsiveness

Safe changes in src/pages/ai/ZenixAI.jsx: memoized transcript/history/action cards, stable action callbacks and unchanged-message identities. Active confirmation/expiry/evidence/recovery behavior remains live. No CSS/SCSS changes. Current vs exact6548e80 AI source, local Chromium390px4xCPU, n10, mock reply350ms; shared working-tree app context is an attribution limitation. 100 unique unresolved EXECUTING messages are genuinely retained; ordinary completed-history cap is unchanged.

| Interaction | Before P50/P95/P99 | After P50/P95/P99 |
| --- | --- | --- |
| 100-message typing / two rAF | 201.3 / 294.4 / 294.4 | 79.6 / 143.3 / 143.3 |
| Send ? pending DOM | 261.3 / 392.6 / 392.6 | 106.5 / 228.9 / 228.9 |
| Mode switch / two rAF | 876.1 / 2389.5 / 2389.5 | 626.3 / 828.2 / 828.2 |
| Mocked verified reply DOM | 783.9 / 989.7 / 989.7 | 604.9 / 682.2 / 682.2 |

19-message input P95 165.6?65.5ms;10-message85.6?45.8ms;empty66.3?73.0ms. Single cold-launch DOM885.2?834.5ms; two-rAF940.8?946.0ms is not a percentile or a speedup. Whole-page long-task count492?272 and end heap19.3?17.1MB are unnormalized observations, not per-action duration or peak memory. Mode-switch828ms, long-history input143ms and send229ms tails still miss targets. Real OpenAI latency/token/quality remains unmeasured on this branch; no credential retrieval or production quota use. Existing safe synthetic provider phase test commands remain applicable.

**Rejected optimization:** content-visibility:auto improved an isolated n6 experiment (mode P95872?284ms), but Chromium1243 AX inspection exposed only6/30 offscreen action buttons in actual chat. A reduced standalone30-button fixture exposed2/30 vs30/30 control, including Accessibility.enable-before-page. Reader anchor/history navigation passed; accessibility gate did not. This style is **absent from production runtime**. Optional ZENIX_AI_CONTAIN harness flag reproduces the rejected experiment only. This observation is not a universal browser/assistive-tech claim; [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility) and [Chrome guidance](https://web.dev/articles/content-visibility) describe expected retained accessibility, so device/assistive-tech validation would be needed before reconsidering.

### Regression verification

- Frontend full259/259; backend605 pass,51 DB-only skips,656 total; backend syntax153 modules.
- Serialized actual disposable PostgreSQL/HTTP179/179, no skips: subscriptions/resource concurrency, tenant/branch isolation, checkout/refunds, AI evidence/confirmation/replay, bootstrap parity and new microsecond-cursor/scoped catalog tests.
- Existing AI browser28/28; design23 CSS/SCSS hashes unchanged; imports/readiness/build and CPU/bundle budgets pass. Main gzip116,949bytes; total JS gzip422,629bytes (budgets130,000/470,000).
- Real HTTP+React flows at1366/768/390: synthetic login?dashboard?remote POS, unloaded product search, deliberate503/retry preserving cart,20 rapid scans, branch/draft isolation+reload, confirmed card checkout with exact stock, UI refund with stock restored. Desktop also completes outer full-catalog while preserving active cashier. At390 only branch-selector step temporarily uses768 because existing mobile header hides it; no390 branch-selector success claim. Zero page errors/external requests. Cash/mixed financial paths covered by actual HTTP suite and benchmark, not separately all UI flows.
- Existing complete-catalog POS browser passes390/768/1366/1920 with20 scans each; this checks backward-compatible full snapshot, not remote latency.
- Current-only checkout revalidation: 274 unique sales/90 refunds, stock9816; duplicate replay/tenant assertions pass. No checkout speedup claimed.

| Actual HTTP financial path | N | Current P50/P95/P99 |
| --- | --- | --- |
| checkout_cash | 30 | 97.1 / 131.4 / 134.8 |
| refund_cash | 30 | 84.8 / 157.4 / 207.5 |
| checkout_card | 30 | 68.4 / 137.3 / 143.0 |
| refund_card | 30 | 75.8 / 127.9 / 139.3 |
| checkout_mixed | 30 | 81.3 / 128.5 / 151.0 |
| refund_mixed | 30 | 94.7 / 136.3 / 138.4 |
| concurrent_10 | 30 | 438.3 / 959.1 / 985.4 |
| concurrent_50 | 150 | 1933.1 / 4024.1 / 4218.4 |
| duplicate_replay | 10 | 302.8 / 416.0 / 416.0 |

### Reproduction / evidence

Runtime scripts/tests are committed; large synthetic fixtures and local logs are intentionally not source code. Local evidence: artifacts/performance-progressive-20261017/{http-results.json,browser-results-direct.json,browser-results-journey.json,flows-results-desktop.json,flows-results-tablet.json,flows-results-mobile.json,checkout-results.json}; AI before/after: artifacts/performance-continuation-20261017/ai-interaction-tails. Full logs: performance-progressive-db.log, performance-progressive-checkout.log, performance-progressive-ai-acceptance.log; frontend .cache/performance/progressive-final-tests.log and progressive-build.log.

Use a separately provisioned **disposable local** DB; scripts reject other targets. With NODE_ENV=test and DATABASE_URL=TEST_DATABASE_URL pointing to127.0.0.1:55436/zenix_perf_test, run backend node scripts/benchmark-progressive-bootstrap.mjs; this creates1k/10k/50k synthetic fixtures and captured responses. Run frontend node tests/progressiveBootstrap.browser.mjs (ZENIX_PROGRESSIVE_SAMPLES=6; ZENIX_PROGRESSIVE_DIRECT=true for cold POS), then the documented environment parameters in progressiveFlows.browser.mjs with the local --serve backend. Never point these commands at production. AI: node tests/aiInteractionTails.browser.mjs with argument before (fixed6548e80 source) and argument after for current.

### Remaining coverage / release gates

| Gate | Status | Remaining work |
| --- | --- | --- |
| Progressive architecture + scoped POS recovery | COMPLETED | Code + local regression evidence; production approval remains separate. |
| Universal50k instant usable UI | PARTIALLY COMPLETED | Large parse removed; mobile P95 still2.79s cold and4.43s Dashboard?POS journey. |
| Small catalog / warm router / remote search regressions | PARTIALLY COMPLETED | Documented above; require accepted budget or targeted scheduling/search fix and repeated same-environment validation. |
| AI memoization + confirmation correctness | COMPLETED | Local safe implementation/tests complete; aggressive containment rejected. |
| All AI interactions<100ms | PARTIALLY COMPLETED | Cold launch,100-message typing/send and mode tails remain. |
| Heavy legacy modules/full history | PARTIALLY COMPLETED | Explicit full hydration remains; core historical arrays and high-cardinality tracking/categories still need separately safe architecture. |
| Real Android/keyboard/scanner/printer/multiple terminals | REQUIRES REAL DEVICE | Physical interaction and sustained-memory validation. |
| Isolated authenticated staging and sustained10/50/100 users | REQUIRES STAGING | Authorized isolation/resource attestation unavailable; no production stress. |
| Current-branch real OpenAI | BLOCKED | Dedicated test key/quota unavailable; no credential retrieval. |
| 038/039 production migration | REQUIRES PRODUCTION APPROVAL | No new migration; prior disposable review/rollback constraints retained. |
| Current runtime GitHub CI | COMPLETED | Both new runtime runs passed; exact SHA/run links below. |


## Progressive runtime GitHub verification

- Frontend c28813ba00c5417abfe24eaeb62a9d08974988e1: [Verify Frontend39042059854](https://github.com/Wamwod10/Zenix-Pos/actions/runs/39042059854), **success**. Full tests, design, build, CPU/bundle and responsive login smoke passed.
- Backend073cc699c2474df140d79f32cd7d5172a6a4880d: [Verify Backend39042080150](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/39042080150), **success**. Actual DB/HTTP/catalog, trial/OTP, subscriptions/resource limits/AI, checkout budget, legacy history and backup/restore passed.

Both runtime branches were pushed; AI#19/#11 base commits remain ancestors. This synchronization changes reports only; check the branch-tip workflow as well. Disposable loopback container zenix-perf-progressive-20261017 was verified and stopped after all local tests. No production action occurred. Release remains BLOCKED for the explicitly documented regressions and external validation gates.
