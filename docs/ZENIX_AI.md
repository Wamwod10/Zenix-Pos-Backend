# ZENIX AI — design and implementation record

For the additive P1 tool-calling agent, immutable stock-receipt confirmations and staging checks, see [AI_AGENT_P1.md](AI_AGENT_P1.md). The report-only design below records the prior release.

## Authorized scope and design

Build the new assistant against real, existing POS data. Preserve POS functionality and design. No production activation, paid external calls, deployment or merge is authorized. The provider adapter defaults to disabled; tests exercise its transport contract without a paid model call.

Chosen approach: deterministic local intent routing plus approved read-only aggregate reports; a bounded structured-output model selects verified facts and predefined, condition-checked advice. Server templates render amounts and product/branch labels. The provider receives numeric facts with anonymous references, not raw questions, names, phones, credentials, customer records, SQL or tools. Arbitrary free-form model prose is deliberately excluded from the trusted answer contract to prevent invented metrics and indirect prompt injection.

Alternatives considered: unrestricted text-to-SQL (too broad an authorization surface); provider-driven tool loops (multiple calls and harder cost/permission bounds); the selected single generation with server-selected reports (bounded cost and auditable permissions). Existing `financeReport` business-date/refund/cost rules, role checks, branch scope and business-date helpers are followed. The fixed AI queries retrieve only authorized aggregates; the existing finance service and POS routes are unchanged.

Implementation sequence: policy/config tests; additive monthly request/budget schema; scoped reporting and provider adapter; atomic quota/idempotency; authenticated API; existing-design chat interface; local PostgreSQL, provider-contract and UI regression tests; security review. No dependency or deployment setting changes are required for the existing Node fetch/Zod integration.

## Quota and failure rules

Business: 100 successful requests/month; Premium: 500; Start and unmapped legacy subscriptions: 0. AI requires a writable, valid subscription. Calendar months start at 00:00 Asia/Tashkent, matching billing's timezone. Annual subscriptions receive a fresh quota each calendar month. Unused requests never carry forward; upgrade/trial changes do not reset usage. In-flight reservations count against admission capacity. Downgrade preserves usage and blocks new requests if already at/above the lower cap.

Successful validated answers count once. Failures release the request quota reservation. Attempts still count toward rate limits. Pre-dispatch failures release spend reservations; once generation may have been dispatched, uncertain failures retain the maximum reserved spend conservatively. No automatic paid retries. Request UUIDs are scoped to organization and user; payload changes conflict, pending duplicates do not dispatch again, and terminal retries replay without another charge. Stored results are reauthorized on replay. Expired leases release request capacity but keep uncertain spend. Results expire after 24 hours; prompts are never stored.

## Safety and limits

Each data query uses a bounded repeatable-read, read-only transaction with statement timeouts. Business-wide views are available only to authorized management scopes; cashier/sales reports also filter seller and branch. Inventory/expenses/supplier debt require their own existing module permissions; profit and branch comparison require analytics permission. Customer debt is limited to authorized management analytics scopes. Permissions/session/branch scope are rechecked before returning a provider result and on replay.

Application cost accounting uses integer micro-USD, maximum input/output token allowances, per-request ceiling, per-business monthly budget and shared daily provider budget. Quota and spend reservations use PostgreSQL row locks, not in-memory counters. Rate/in-flight limits are separate from request quota. Provider timeout and response byte/schema limits apply. Provider errors are sanitized and no prompts, aggregates, labels, answers or keys are written to application logs. Provider failure does not affect POS routes.

## Provider decision (disabled candidate)

Candidate: OpenAI GPT-6 Luna via Responses API, disabled by default. Standard uncached text pricing is USD 0.10 input / 0.50 output per million tokens (verified 2026-10-15). At 8,000 input and 1,200 output tokens the configured estimate is USD 0.00140/request. Failed dispatched requests retain reserved spend. Requests use store:false, strict JSON schema and reasoning effort none; tools and retries are not enabled. Before dispatch, a conservative bound budgets one token per UTF-8 byte of the complete request plus 256 framing tokens, and checks input and maximum request spend limits. This may reject requests an exact tokenizer would accept. Actual usage is validated again after generation. Model/rates are pinned in code.

Official sources: [Google pricing](https://ai.google.dev/gemini-api/docs/pricing), [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output), [token counting](https://ai.google.dev/gemini-api/docs/tokens), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). Published low-latency/cost claims are not a measured Zenix benchmark. Real latency, Uzbek response quality, billing rates, project-paid status and data-processing terms must be checked with the approved account before rollout. Google free-tier product-improvement terms are unsuitable for private business data; approval gates explicitly require the paid-project and data-processing decisions.

## Provider comparison

Standard uncached USD per 1 million text tokens, verified from official pages on 2026-10-12. Costs exclude tax, currency conversion and any provider/account-specific fees.

| Candidate | Input / output | 8,000 input + 1,200 output | Data / speed decision |
| --- | --- | --- | --- |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 | $0.00128 | Cheapest of these candidates; paid-project and data-processing approval required. Selected disabled adapter. |
| [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) | $0.40 / $1.60 | $0.00512 | API training disabled by default; standard abuse-monitoring retention applies, ZDR requires eligibility/approval. |
| Claude Haiku 4.5 | $1.00 / $5.00 | $0.014 | Higher token cost for this bounded selection task; retention/contract must be reviewed before integration. |

Zenix p50/p95 latency and Uzbek quality are not measured for any live model. These lightweight models are candidates for latency testing, not a claim that one is fastest. The selection contract does not depend on fluent model prose. A provider replacement requires contract tests, reviewed model availability/prices and a new pinned pricing version. No fallback automatically sends data to a second provider.

## Implemented API and frontend

`GET /api/ai/status`: authenticated organization, existing module permissions, actual effective tier, monthly used/reserved/remaining, next reset, subscription writability, provider availability and authorized suggestions. Token/spend statistics are restricted to `moduleBilling` permission. Expired subscriptions may read this endpoint.

`POST /api/ai/chat`: strict `{ requestId: UUID, question: string(1..1000), storeId?: UUID|null }`. Server authenticates, checks writable subscription, classifies/authorizes intent, enforces branch/seller scope, reserves quota/cost, builds a read-only snapshot and checks actor/session permissions before dispatch and after response. Returns verified answer, bounded facts/tables/notes and fixed advice. It accepts no organization ID, model, price, quota, SQL or action from the browser. Start/unmapped legacy subscriptions are denied. Invalid/injected questions never reach the provider. Unknown historic cost remains null; money uses PostgreSQL numeric/BigInt and profit rounds to .01 UZS. Recent product arrivals are excluded from the 30-day unsold list. Branch presentation is capped at 20, product lists at 10; today's totals are unpaginated.

Frontend `/ai` uses existing `PageHeader`, `PremiumSelect`, cards, buttons, fonts and theme variables. It shows remaining requests/reset, role-approved suggestions, branch scope, metrics/tables, upgrade links, loading/errors and expiration explanations. History is memory-only and bounded; each question is a separate analysis (no model conversation memory). Ambiguous transport retries reuse the same UUID; terminal failed requests use a new UUID. React renders all text escaped. No provider key or direct provider call exists in the frontend.

## Environment and operational caps

All values below are **backend only**. No key was added to local or production environments, and no paid provider call was made.

Activation requires `ZENIX_AI_ENABLED=true`, `ZENIX_AI_PROVIDER_APPROVED=true`, `ZENIX_AI_DATA_PROCESSING_APPROVED=true`, `ZENIX_AI_PAID_PROJECT_CONFIRMED=true`, and a server-only `OPENAI_API_KEY`. Production additionally requires `ZENIX_AI_PRODUCTION_APPROVED=true`. Leave all flags unset/false until account, spend, privacy and rollout approval. Model is pinned to `gpt-6-luna`; requests use https://api.openai.com/v1/responses and a Bearer authorization header, with redirects/retries/tools disabled. Response storage is disabled with `store:false`.

| Backend setting | Default | Meaning |
| --- | --- | --- |
| `ZENIX_AI_MAX_INPUT_TOKENS` | 8000 | Token-count preflight includes system/config input; upper bound 8000 |
| `ZENIX_AI_MAX_OUTPUT_TOKENS` | 1200 | Output plus any reported thinking; upper bound 1200 |
| `ZENIX_AI_TIMEOUT_MS` | 20000 | Shared report/provider deadline; each report SQL has 2s timeout |
| `ZENIX_AI_MAX_REQUEST_MICROS` | 2000 | $0.002 reserved per generation; successful exact token cost replaces reserve |
| `ZENIX_AI_BUSINESS_MONTHLY_MICROS` | 500000 | $0.50 independent monthly spend cap |
| `ZENIX_AI_PREMIUM_MONTHLY_MICROS` | 2500000 | $2.50 independent monthly spend cap |
| `ZENIX_AI_DAILY_MICROS` | 25000000 | Shared $25 Tashkent calendar-day spend cap |
| `ZENIX_AI_USER_PER_MINUTE` | 3 | Admitted attempts including failures |
| `ZENIX_AI_BUSINESS_PER_MINUTE` | 10 | Admitted attempts for entire business |
| `ZENIX_AI_MAX_CONCURRENT` | 2 | In-flight requests for entire business |

Currency accounting is integer micro-USD, rounded upward per request; provider estimates are not UZS subscription charges. Missing/invalid usage or dispatched failures conservatively charge the full $0.002 reserve while restoring request quota. Statistics record successful validated token usage; uncertain failures have cost but unknown tokens. Admission locks organization → daily budget → monthly counter, without holding database locks over network calls. Leases expire at90s; bounded global recovery prevents one crashed tenant from blocking another's daily budget. Enabled servers run maintenance every60s and admission also recovers leases. Replay results expire logically at24h; bounded maintenance clears expired JSON results. Accounting tombstones remain for idempotency and financial audit; no raw prompt is stored. Rejected pre-admission requests do not consume AI quota or provider spend.

## Changed files

Backend new: `migrations/035_zenix_ai.sql`, `src/config/ai.js`, `src/routes/ai.js`, `src/services/aiPolicy.js`, `aiReports.js`, `aiProvider.js`, `aiQuota.js`, `aiChat.js`, `aiMaintenance.js`, `tests/aiSafety.test.mjs`, `aiProvider.test.mjs`, `aiDatabase.test.mjs`, this document. Wiring/checks: `src/app.js`, `src/server.js`, `src/db/verifySchema.js`, `src/middleware/workspaceRevision.js`, `tests/workspaceRevision.test.mjs`, `tests/database-production.test.mjs`, `tests/tenantIntegrityMigration.test.mjs`, `tests/subscriptionMigration.test.mjs`.

Frontend new: `src/pages/ai/ZenixAI.jsx`, `src/pages/ai/zenixAi.scss`, `tests/aiBackend.test.mjs`. Wiring/messages: `src/App.jsx`, `src/layout/MainLayout.jsx`, `src/services/apiClient.js`, `scripts/test-frontend.mjs`, `design-baseline.json` (only new scoped stylesheet added). Prior billing/resource changes are retained.

## Verification and rollout

Temporary loopback PostgreSQL only: migrations001–035 converge; schema validation passes (61tables,35migrations,181indexes). Additive migration replay preserves existing payment/shift/license history. AI policy/provider/database tests cover limits, concurrent final slots, idempotency, quota release, uncertain spend, global crash recovery, month isolation, upgrade/downgrade, tenant/branch/seller scope, unknown cost, exact decimal sales/refunds, revoked/in-flight permissions, deadline, fabricated IDs and sanitized provider failure. Chromium tests use real authentication/Express/PostgreSQL and replace only the paid provider boundary; this proves integration, **not live-model connectivity or measured quality**.

Observed final checks: backend full suite444 passed/39 opt-in database tests skipped; AI-specific checks23 passed across policy/provider/real-PG runs; real PG/API billing/resource/sales regression54 passed (plus the subsequent new busy-tenant recovery test passed); frontend standalone222 passed and combined backend-contract suite342 passed/2 opt-in browser tests skipped; Chromium AI6 passed in an isolated final run; migration-history/replay1 passed; frontend build passed;119 backend JS modules syntax passed; all23 CSS/SCSS baselines passed; tracked diff whitespace checks passed. Database tests used explicitly gated loopback databases. An older schema-recreating test was removed from the shared database run after a fixture collision; final regression was sequential in a separate database. Chromium's10s startup timeout occurred under simultaneous full-suite load; isolated final execution passed in7.6s. No failing assertion remains in the final selected checks.

Recovery skips organizations locked by POS work (`FOR UPDATE SKIP LOCKED`), bounds its batch/time and uses50ms lock timeout. Expected contention skips a lease instead of failing another tenant's admission; unexpected accounting errors fail closed. A dedicated test holds one organization's lock while another admits a request. AI accounting POSTs do not bump the POS workspace revision. Maintenance errors are sanitized.

Before an approved staging rollout: apply035 after033–034 using the existing migration runner; confirm schema readiness; use an approved paid project and restricted key; run live transport/usage/latency/Uzbek evaluation with nonproduction fixture data; reconcile provider billing to ledger; monitor `AI_TIMEOUT`, `AI_COST_LIMIT`, quota and cleanup errors. Do not activate production until reviewed approval.

Rollback: unset `ZENIX_AI_ENABLED`, stop admission, let dispatched calls settle and maintenance recover leases; remove frontend AI entry if needed. Roll back application wiring only; retain additive AI accounting tables and prior subscription data, with no down-migration/delete. No production database, deployment settings, GitHub main, commit, push, merge or deploy was touched.
