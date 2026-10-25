# Original audit traceability — source incomplete

The requested `ZENIX_POS_MASTER_AUDIT_85_FINDINGS_2026-10-25.md` was not present in either worktree, fetched main tree or project parent directory. Its path/content was requested. The prompt names **31 distinct IDs**, and describes only some of them. The other **54 IDs and their evidence are unavailable**. They are not invented here. Consequently this is an incomplete traceability matrix, not an85/85 audit sign-off.

Severity is P1 where explicitly prioritized by the prompt; otherwise UNKNOWN until the source is supplied. Ownership B/D/F means backend/database/frontend. Earlier evidence below is from the prompt, not an unseen audit file.

|ID|Module / severity / owner|Prior evidence and reproduction|Root cause / fix status|Tests / remaining risk|
|---|---|---|---|---|
|NEW-01|Customer RBAC / P1 / B,F|Sales permission allowed financial profile changes; role HTTP reproduction|CONFIRMED_FIXED: dedicated financial permission, preserved contact edits|Authorization unit+HTTP role/grant/deny matrix; custom role policy requires review|
|NEW-02|Customer cash / P1 / B,D,F|Repayment reduced debt without shift cash|CONFIRMED_FIXED: atomic ledger/allocation/provenance/movement, replay|Parallel, rollback, closed replay, tenant/register tests; historical rows untouched|
|SHIFT-01|Shift cash / P1 / B,F|Limited bootstrap used for expected cash|CONFIRMED_FIXED: server aggregate and stale-close guard|1–10000 sales, HTTP scope/close; production load not benchmarked|
|BACK-01|Finance/refund / P1 / B|Seller/refund actor semantic mismatch|NEEDS_BUSINESS_DECISION: retain historical attribution|Source inspection; approved KPI definition missing|
|SELL-03|Seller KPI / P1 / B,F|Original seller versus refund operator|NEEDS_BUSINESS_DECISION|No guessed historical rewrite|
|EXP-01|Expense dates / P1 / B,F|Selected date differs from posting date|NEEDS_BUSINESS_DECISION: branch cutoff corrected; selected/posting policy unresolved|Branch boundary DB regression; historical regrouping risk remains|
|P3-01|Branch costing / P1 / B,D,F|Product global cost versus branch average|CONFIRMED_FIXED for receipt/sale zero-cost fallback and branch catalog/UI valuation|Two-branch real DB receipt/catalog test; transfer/return remains P3-02|
|P3-02|Branch costing / P1 / B,D,F|Multi-branch valuation and snapshots|NEEDS_BUSINESS_DECISION for transfer/return policy|No historical cost backfill|
|P4-01|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|P4-02|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|P4-03|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|P4-04|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|P4-05|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|NEW-04|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|NEW-05|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|NEW-06|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|NEW-09|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|NEW-11|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|NEW-12|UNKNOWN / UNKNOWN / UNKNOWN|Original description absent|NOT_VERIFIED|Source required|
|SUP-01|Supplier / UNKNOWN / B,D|Exact original description absent|NOT_VERIFIED for original ID|Invoice replay fixed independently; no assumed ID mapping|
|SUP-02|Supplier / UNKNOWN / B,D|Exact original description absent|NOT_VERIFIED for original ID|Advance/drawer provenance policy remains|
|SUP-03|Supplier / UNKNOWN / B,D|Exact original description absent|NOT_VERIFIED for original ID|Multi-invoice allocation history gap remains|
|BACK-02|Backend / UNKNOWN / B|Original description absent|NOT_VERIFIED|Source required|
|BACK-03|Backend / UNKNOWN / B|Original description absent|NOT_VERIFIED|Source required|
|DB-01|Database / UNKNOWN / D|Original description absent|NOT_VERIFIED for original ID|Local migrations/schema/integrity checked separately|
|DB-03|Database / UNKNOWN / D|Original description absent|NOT_VERIFIED for original ID|Production historical validation/restore not executed|
|BRANCH-01|Branch / UNKNOWN / B,D,F|Original description absent|NOT_VERIFIED for original ID|Branch cutoff/scoping fixes independently tested|
|BRANCH-02|Branch / UNKNOWN / B,D,F|Original description absent|NOT_VERIFIED|Source required|
|INV-01|Inventory / UNKNOWN / B,D|Original description absent|NOT_VERIFIED|Source required|
|INV-02|Inventory / UNKNOWN / B,D|Original description absent|NOT_VERIFIED|Source required|
|INV-03|Inventory / UNKNOWN / B,D|Original description absent|NOT_VERIFIED|Source required|

The54 unavailable IDs cannot be classified as FRONTEND_OWNER, verified positives, conditional risks or defects without their descriptions. Preserve this gap when reviewing the PR.

## Independently confirmed issues (not assigned invented original IDs)

|Finding|Status|Evidence / tests|
|---|---|---|
|Duplicate manual supplier invoice submission|CONFIRMED_FIXED|Parallel identical requests create one invoice; actor/intent collision rejects; audit failure rolls back|
|Same-tenant file purpose/ownership exposure|CONFIRMED_FIXED|Product/expense upload/bind/read/delete matrix, MIME and legacy inference|
|Cross-branch expense attachment exposure|CONFIRMED_FIXED|Branch-locked explicit permission cannot read/bind/delete foreign-branch receipt|
|File lock wait uses stale attachment policy|CONFIRMED_FIXED|Real lock-wait test reloads references and rejects cross-purpose bind|
|History-only finance exposes expenses/profit|CONFIRMED_FIXED|Denied details, counts and aggregates omitted; analytics aggregate-only policy|
|Invalid timezone/startTime accepted|CONFIRMED_FIXED|Settings HTTP400 and strict HH:mm validation|
|Customer overdue uses DB-session calendar|CONFIRMED_FIXED|Tenant timezone SQL and opposite-date boundary fixtures|
|Branch expense cutoff differs from sale cutoff|CONFIRMED_FIXED|Actual DB boundary regression|
|Shared DB integration files reset each other's schema|CONFIRMED_FIXED|Default npm test serializes files; no assertions removed|
|License expiry test mixes DB and tenant calendars|CONFIRMED_FIXED|Fixture uses explicit UTC date, matching its org timezone|
