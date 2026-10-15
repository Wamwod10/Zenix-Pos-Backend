# ZENIX AI P1 implementation and release contract

Extend the existing disabled OpenAI provider; retain legacy report interfaces. Use bounded strict Responses function calls for product search, stock, locations, existing reports and stock receipt preparation. No SQL, credentials, permission claims or execution tools are supplied to the model.

Server conversations bind to organization, user, session, branch and permission fingerprint, expire after 30 minutes, and serialize concurrent turns. Older complete turns are trimmed against the full provider request budget. The server renders verified tool results and controls all greetings, clarification and general advice; arbitrary model prose cannot invent facts or claim execution. Confirmation tokens never enter model history. Unknown entities and missing required receipt fields require clarification.

Stock receipts use the existing inventory receipt transaction, ledger, notifications and audit. A separate immutable action expires after five minutes, binds all fields and the original actor/session, and requires an explicit confirmation endpoint. Recheck permissions, subscription, warehouse/product state and original successful AI request under locks; replay one completed receipt on duplicates. Preparation alone changes no business stock. `ZENIX_AI_ENABLED=false` and `ZENIX_AI_WRITES_ENABLED=false` are defaults.

Implementation plan:
- [x] Extract shared receipt business service; implement scoped tools and immutable confirmation transaction plus additive migration 036.
- [x] Extend bounded Responses transport and allowlisted `ZENIX_AI_MODEL`; test function calls, usage, errors and cancellation.
- [x] Wire quota-preserving agent loop and session-scoped conversations plus additive migration 037.
- [x] Mount one persistent frontend panel with topbar/floating triggers and explicit action cards.
- [x] Verify unit, isolated PostgreSQL, HTTP, frontend build and UI/security scenarios; independently review changes.
- [x] Push feature branches and open backend/frontend draft PRs. Do not merge, migrate production or deploy.

P2 writes (products, expenses, customers, transfers), expanded time-window analytics and forecasts remain unavailable. Migration files are reviewed artifacts; they are not run on startup. Staging acceptance and a separately approved synthetic OpenAI smoke test are required before activation.

## Release checks and remaining work

Backend syntax: 130 modules. Backend unit/security: 502 passed, 44 DB-dependent tests skipped. Separately executed local PostgreSQL integration: 66 passed, including actual receipt/warehouse ledger, confirmations, conversations, quotas, billing and existing POS regressions. Dedicated OpenAI/agent provider tests: 44 passed using mocked Responses transport. No production records were read or changed.

After the additional POS workspace-sync assertion, all 18 agent action/conversation/HTTP integration checks passed again; confirmed receipts bump the existing workspace revision exactly once. The new DB checks are also wired into the existing isolated PostgreSQL CI job. Frontend standalone suite: 225 passed; bundle build and the 23-style design baseline passed. Mocked browser checks cover light/dark at 320–1440px, open/closed checkout access, header dropdown stacking and permission-change context reset.

Draft pull requests: [backend #5](https://github.com/Wamwod10/Zenix-Pos-Backend/pull/5), [frontend #9](https://github.com/Wamwod10/Zenix-Pos/pull/9). These include earlier provider work without merging or altering its branch.

Only `gpt-6-luna` is currently allowlisted through `ZENIX_AI_MODEL`, with pinned audited rates; other models disable the optional AI runtime rather than preventing POS startup. New models need reviewed schema/usage/pricing tests. Serial/IMEI receipts require the existing manual receipt UI. Incoming cost, selected warehouse, required batch and new expiry date must be explicitly provided; old batch dates are not reused. Ordinary text confirmation never executes.

Apply both feature branches to staging first. Run migrations 036/037 only through the existing controlled migration command against the confirmed staging database; retain all existing migrations and accounting records. Verify the frontend against that staging backend. Keep both AI flags false until acceptance, account/data-processing approvals and spend controls are confirmed.

The OpenAI key exists only in the user's Render environment and was not available to this local runner. Real upstream connectivity has **not** been claimed. In an approved test environment with the key already present, run `ZENIX_AI_LIVE_SMOKE=true ZENIX_AI_ENABLED=false node scripts/aiAgentLiveSmoke.mjs` (shell-appropriate environment syntax). This script has no DB/application imports, uses only a fixed synthetic tool, checks both call and final structured reply, enforces cumulative token/spend limits, and prints only usage totals. Its guard and transport were tested with mocks. Do not paste or copy the key into logs, GitHub, chat or frontend variables.

OpenAI function-call request shapes follow [official documentation](https://developers.openai.com/api/docs/guides/function-calling). Pricing/model capabilities follow [GPT-6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).
