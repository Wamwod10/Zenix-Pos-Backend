# ZENIX POS release readiness — 2026-10-17

**NOT READY FOR PRODUCTION RELEASE.** Local optimizations are reviewable on existing performance PRs, but the release gates below remain open. No main merge, deployment, production DB write or migration was performed.

## Ready for review

- Existing catalog/cart/barcode/date-filter/capacity/index improvements preserved.
- Complete bootstrap product query preaggregates tenant/branch inventory; full 50k-row equivalence and real-route branch regression passed.
- Complete inventory normalization yields between bounded slices and cancels stale generations. No partial snapshot is marked ready.
- AI static report content avoids repeat rendering during typing; confirmation/expiry/authorization remain live.
- Optional bounded bootstrap/AI phase metrics contain fixed labels and durations only.
- 45 synthetic browser control checks cover 15 modules; 28 existing AI acceptance cases pass. This is representative coverage, not certification of every button.

## Unfinished work and release blockers

| Gate | Status | Next safe action |
|---|---|---|
| Full 50k bootstrap/mobile responsiveness | PARTIALLY COMPLETED | Snapshot is still 23.3MB JSON; mobile parse ~0.5–0.7s, usable POS ~5s under 4x CPU. Design server-paged lookup and module-specific hydration with complete POS/stock parity before adoption. |
| Consistent AI/mobile <100ms feedback | PARTIALLY COMPLETED | Memo improves send/report tails, but mobile send P95 102.9ms and mode P95 541.7ms miss targets; profile real Android before release claim. |
| Real Android, keyboard, scanner, receipt printer, sustained memory | REQUIRES REAL DEVICE | Test physical devices and long sessions; browser scanner events do not certify hardware. |
| Authenticated isolated staging including checkout/AI | REQUIRES STAGING | Operator must provide authorized staging access and attest isolated nonproduction DB. Existing staging requires token/allowlist; credentials were not retrieved. |
| Sustained 10/50/100 realistic users | REQUIRES STAGING | Confirm adequate resources first; local short synthetic cohorts are not hosting capacity certification. |
| Current-branch live OpenAI latency/token/quality | BLOCKED | No authorized local test key. Use dedicated synthetic test quota; never production users' quota. Prior synthetic live smoke is historical evidence only. |
| Migrations 038/039 execution | REQUIRES PRODUCTION APPROVAL | Review backup/restore, locks, disk/IO, finite/unlimited/concurrent limits, nontransactional runner and rollback window before separate approval. |
| Every destructive/export/branch/permission control scenario | PARTIALLY COMPLETED | Complete staging persistence/error/recovery coverage; synthetic 45 checks do not establish all operations. |

## Verification and CI

Full frontend 253/253 and backend standalone 600 pass/50 DB-only skips; backend syntax 150 modules. Design baseline (23 CSS/SCSS), imports/readiness, production build, CPU/bundle budgets and final AI 28-case browser suite passed. Final bundle main gzip 113,908 bytes; total JS gzip 419,053 bytes, within existing broad regression budgets. These are not production SLAs.

Final disposable integration and checkout verification and pushed-head CI results are recorded in the final verification section of `PERFORMANCE_AUDIT.md`. Earlier green CI heads must not be treated as verification of later commits. Existing CI workflows remain enabled; new real-route aggregation test is included in backend CI.

## Migration risks

038 maintains security-invoker capacity checks and subscription enforcement; disposable finite/unlimited/concurrency/downgrade and unprivileged-role tests passed. 039 creates the tenant/product/store index concurrently outside a transaction using the existing runner directive. It complements store-leading indexes. On 100k balances, concurrent build was ~283ms and index ~6.9MB; this cannot predict production duration or disk requirements. A virtual-transaction wait was observed while independent writes continued. No reliable write-overhead conclusion follows from the noisy ten-batch test.

## Staging and external provider

No staging stress test was performed because authenticated access and DB isolation were not established. No production Render/Neon load test was performed. Local phase tests execute actual DB/evidence/confirmation/quota code with a fixed-delay mock provider, not real OpenAI latency. With an already authorized dedicated test key supplied by the operator, use the existing opt-in `scripts/aiAgentLiveSmoke.mjs` (`ZENIX_AI_LIVE_SMOKE=true`, normal AI disabled) and `scripts/aiConversationEval.mjs` against synthetic cases; inspect each script's required flags before use. No command retrieves credentials.

## Release order — operator action only

1. Resolve blockers and review the complete audit; verify final CI and tested commit SHAs.
2. Merge/release AI backend #11 and frontend #19 dependencies before performance backend #12/frontend #20; preserve stacked ancestry.
3. Obtain separate migration approval, test backup restore and schedule monitored capacity/index rollout with disk and lock limits. Do not edit historical migration checksums.
4. Release backward-compatible backend, then frontend through the approved deployment process; verify tenant/branch isolation, billing, checkout/replay, inventory and AI evidence on staging first.
5. Observe error rate, pool waits, query/HTTP tails, event loop, memory and UI long tasks; stop promotion if correctness or performance regresses.

## Rollback

Use the deployment system's previously verified backend/frontend revisions. The response protocol remains compatible. Keep financial records and audit history intact; never undo sales by deleting rows. For 039, an approved `DROP INDEX CONCURRENTLY` outside a transaction can remove the optional index after checking dependencies. For 038, restore the prior 034 function definitions before removing the overload, following the disposable-tested script; review any intervening data/capacity changes. Do not automatically delete migration history or alter production schema during application rollback.

PRs: [Frontend #20](https://github.com/Wamwod10/Zenix-Pos/pull/20), [Backend #12](https://github.com/Wamwod10/Zenix-Pos-Backend/pull/12). Full measured limitations and raw evidence paths: `PERFORMANCE_AUDIT.md`.

## Verified runtime CI

- Frontend runtime `3c05aff`: [39022937418](https://github.com/Wamwod10/Zenix-Pos/actions/runs/39022937418) **success**.
- Backend runtime `3892e96`: [39023031810](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/39023031810) **success**.
- Final local serialized DB/HTTP/security 166/166 plus trial/OTP 12/12 passed; checkout benchmark 274 sales/90 refunds and duplicate/stock assertions passed. Final report synchronization is documentation only; branch-tip CI must also pass before release.
