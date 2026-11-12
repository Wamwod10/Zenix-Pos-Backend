# ZENIX POS — Verified Production Acceptance (2026-11-12)

**Evidence scope:** ZENIX POS SaaS backend in confirmed Render **My Workspace**, Neon project `steep-wind-39440568`. The facts below were read back from live providers, not inferred from a test suite. This report does not certify physical equipment or third-party message receipt.

## 1. Production backend and connectivity

- Render web service: `srv-darqr0l9fdbs73amtig0`, deployed backend SHA `0f4f7c55bc03e7876c2983ff212c64a209354dd5`, deployment `dep-dbqrj6brjlhs73a86t3g` **LIVE**.
- Backend `main` CI run [43223475186](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/43223475186) **SUCCESS**.
- Render Node.js 22.23.5, `npm install` audit **zero vulnerabilities**.
- Startup log: database connected to `neondb`, API listening, `[runtime] api-notification-workers=enabled`, outbox monitor started and Telegram/payment-Telegram webhook URL configurations logged. Previous warning about PostgreSQL TLS compatibility **did not recur** after explicit `sslmode=verify-full`.
- Read-only Render error logs for the post-deployment interval: zero entries at time of inspection.
- A GET-only GitHub Actions probe on [run 43220146527](https://github.com/Wamwod10/Zenix-Pos-Backend/actions/runs/43220146527) returned **200** for both `/health` and `/ready`, with `database=ready`.

## 2. Production database foreign keys — DONE

**Before:** 222 foreign keys, **68 NOT VALID**. Before DDL, read-only orphan checks across these 68 constraints found **zero violations**.

**Staging rehearsal:** A separate Neon child branch `br-delicate-meadow-b12lwp5h` was created with parent `br-small-dew-b197rvkz`, its own small compute `ep-gentle-flower-b1on4tnc`, and NOT a production endpoint. All 68 constraints successfully changed to VALID on this branch, using bounded batches. Child branch auto-expiry is set for **2026-11-13T13:30:00Z** to avoid leaving an indefinite extra resource.

**Production rollout:** The 68 constraints were then validated online in batches (first 8, then five batches of 12). Each batch used a single transaction with `lock_timeout=2s` and `statement_timeout=60s`; on failure, the batch would have aborted. There were no reported failures or blocking lock alerts.

**After:** production `pg_constraint` has 222 foreign keys, all **validated**. A separate grouped `pg_constraint` query confirmed **zero NOT VALID** constraints for FK, CHECK, NOT NULL, PK, constraint triggers, and unique types. Production lock and long-running-query diagnostics were clear. No sales, inventory, customer or billing row was modified as part of these `VALIDATE CONSTRAINT` statements.

Read-only verification SQL:

```sql
SELECT contype, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE NOT convalidated) AS not_valid
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
GROUP BY contype
ORDER BY contype;
```

**Important:** PostgreSQL `VALIDATE CONSTRAINT` strengthens historical integrity metadata and performs relation scans, but is **not** a replacement for financial transaction correctness tests.

## 3. Neon snapshot restore — BLOCKED by root-branch quota, not completed

- Existing daily snapshot `snap-sparkling-breeze-b1sz42w7` was confirmed to belong to the expected production branch and was retained; no existing snapshot was removed.
- A **non-finalizing** restore was explicitly requested with `finalize:false` and an isolated new branch name. Neon returned **HTTP 422 `root branches limit exceeded`**; no newly restored snapshot branch was produced.
- Do not retry with `finalize:true` or alter the default branch to bypass this quota. Previous incident [Zenix-Pos #97](https://github.com/Wamwod10/Zenix-Pos/issues/97) involved accidental production endpoint reassignment during restore.
- Live production branch `br-small-dew-b197rvkz` remained **default=true**, **protected=true**, **READY**; endpoint `ep-patient-field-b1xbogfo` remained **active read_write** on that branch after the failed restore and FK validation.
- The successful child-branch FK rehearsal **does not count as a snapshot restore test**.
- Remaining action in [issue #38](https://github.com/Wamwod10/Zenix-Pos/issues/38): obtain additional Neon root-branch allowance or review and specifically approve a safe historic backup root-branch cleanup. Only then retry a **non-finalizing**, separately verified snapshot restore and inspect its isolated data and compute routing.

## 4. Telegram — operational queues clean, live human delivery unverified

Read-only `neondb` queries after deploy and FK validation:
- `notification_outbox`: 129 records, **129 sent**, **0 pending**.
- `notification_deliveries`: 96 records, **96 sent**, **0 pending**.
- Render My Workspace has **no additional `zenix-pos-worker` service**, and the existing API logs the embedded worker as enabled. Do **not** create a second queue consumer without a single-owner cutover plan.
- Existing synthetic Telegram/webhook authorization and callback tests run in backend CI.

**Not verified:** a real human admin receiving an explicit test notification, and a genuine Telegram callback through production authorization/webhook and approval UX. Those operations require legitimate admin access and may have transactional impact. Track via [issue #40](https://github.com/Wamwod10/Zenix-Pos/issues/40).

## 5. Render health-check configuration — MANUAL DASHBOARD ACTION still open

Existing Render service `serviceDetails.healthCheckPath` is still **empty** (TCP-only); `buildCommand` is `npm install` even though repository `render.yaml` defines `/ready` and `npm ci`. The connected Render API tools do not include an update-service health-check setter. No Blueprint is associated with this particular existing service; **do not create another live service**.

Operator checklist, tracked in [backend issue #67](https://github.com/Wamwod10/Zenix-Pos-Backend/issues/67):

1. Open the [existing Render service](https://dashboard.render.com/web/srv-darqr0l9fdbs73amtig0) and choose **Settings → Health Checks → Edit**.
2. Set the HTTP health-check path to **`/ready`**, save.
3. Read back the exact service from Render, verify path `/ready` and `autoDeploy=no`.
4. Watch live health check success, 5xx/error logs, DB/Telegram queues and rollback to prior TCP configuration if health checks fail.

Render's HTTP check accepts a 2xx or 3xx response within 5 seconds and can restart failing instances; a separate supervised live settings change is necessary. Do not misuse an environment variable or unreviewed Blueprint to simulate the update.

## 6. Physical POS acceptance — ON-SITE operator required

Synthetic Playwright/browser and backend POS tests pass in the normal frontend and backend CI pipelines. Physical certification is **not** possible through connected cloud tools.

Capture an operator-signed pass/fail session for each: USB scanner/HID keyboard wedge (valid, invalid, rapid duplicate barcode), touch/cashier navigation, 58/80 mm receipt printer legibility/currency, cash drawer triggering and permission, offline/reconnect and idempotent checkout, parallel browser/tab checkout with unchanged financial totals, refunds, cancelled payments and shift closure. Capture only synthetic or anonymized records and keep transaction ids for reconciliation. Track via [frontend issue #42](https://github.com/Wamwod10/Zenix-Pos/issues/42).

## 7. Scope and remaining risk

**Completed:** backend security dependency and TLS fixes in production, all 68 previously unvalidated production FKs validated with zero failures, clean Render error sample, proper production Neon branch/endpoint mapping, zero pending Telegram outbox, isolated FK rehearsal.

**Not completed / requires external approval or physical access:** existing Render service HTTP health-check config, a fresh *snapshot* restore rehearsal due Neon root-branch quota, physical POS hardware acceptance, and real Telegram admin message/callback delivery verification.

Do not claim the entire platform is 100% certified or merge backend/Render configuration changes merely to make a dashboard appear green.
