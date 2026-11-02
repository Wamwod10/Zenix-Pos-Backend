# Zenix AI — answer relevance quality gate (Phase 1)

Scope: improve **clarity and answer relevance** without relaxing data verification, tenant isolation, authorization, write confirmations or cost limits.

## Observed baseline and limits
- The production read-only audit on 2026-11-01 found nine recorded successful October AI requests; that is **not** an accuracy or latency sample.
- Backend logs included `unsupported_numeric_claim` answer recovery and `ai_accounting_cleanup_failed` cleanup signals. This PR does not change accounting.
- A successful frontend/backend CI or synthetic provider test **does not establish** human-level answer quality.

## Response contract
1. Answer the last question directly in conversational Uzbek. One metric/question -> one brief answer, with the necessary period and authorization scope.
2. Don't show unrelated gross/refund/debt/inventory data when asked only for net sales. Detailed reports belong in the optional expanded section.
3. If facts are missing, ask **one** targeted question or say exactly what cannot be verified. Never invent quantities, dates, trends or causes.
4. For `nega?`/causal questions, use verified comparison evidence or distinguish observation from conjecture.
5. For explicit broad business advice, prioritize at most three actionable checks. Do not dump the multi-topic overview.
6. For follow-ups, use only validated entity identity and request fresh financial facts. Avoid stale sale totals from chat history.
7. Keep all model claims inside evidence-anchor validation; refuse unverified financial numbers. Preserve idempotency, tool permissions and write confirmation.

## Acceptance questions (test with synthetic / nonproduction data first)
| User question | Required response | Forbidden |
| --- | --- | --- |
| Bugun qancha savdo qildim? | Today's *net* sales, one sentence | Gross, refunds, generic advice unless asked |
| Bugun nechta savdo qildim? | Sales count | Confusing count and sum |
| Bugungi yalpi savdo qancha? | Gross sales | Reporting net as gross |
| Bugun qaytarish summasi qancha? | Refund sum | Hiding returns or changing date |
| Xarajatlar jami qancha? | Explicit period + expense sum | Calling weekly total today's |
| Nega savdo ko‘paydi? | Verified cause only with appropriate comparative evidence; otherwise say what's missing | Invented reasons |
| Eng ko‘p qaysi tovar sotilgan? | Correct net quantity and unit; mention ties or incompatible units | Treating product packaging numbers as sold quantity |
| Mijozlarning qarzi qancha? | Scope-checked current receivables | Revealing another tenant's debt |
| Bu mahsulotdan omborda qancha bor? | Authorized product/warehouse and stock | Unverified name or unit |
| Kirim qil | Preview, user confirmation and server recheck | Autonomous inventory write |

## Release gates
- Node syntax + deterministic unit tests, existing AI security tests and GitHub backend CI pass.
- Evaluate the real model with approved **synthetic test fixtures** and compare short-answer relevance, unsupported claims, context continuity and latency against the baseline; keep per-case redacted results.
- Do not submit production data to third-party model tests without verifying the account's data-processing approval; keep secrets out of logs.
- Deploy only after an explicit release decision and rollback plan; the PR by itself changes no production service.
- Track actual outcomes in read-only aggregate measurements; no unsupported “95% success” claims.

## Future phases (not implemented in this PR)
- Prompt/tool routing tuned using failures from curated Uzbek question sets.
- Safer long-conversation summarization and follow-up references.
- User feedback capture (helpful / incorrect / too long) with privacy controls.
- Aggregate response quality, p50/p95 latency, fallbacks and tool usage dashboards.
- Optional provider/model comparison only after pricing, rate, compatibility and data handling are verified.

## Synthetic live-model evaluation (requires separately approved nonproduction access)

The existing `scripts/aiConversationEval.mjs` contains 40 isolated synthetic Uzbek questions (8 conversations). It never queries the POS database or loads tenant data; it uses its own fixed read-only synthetic tool. Its optional live mode **does invoke a paid OpenAI API** and must not be run against production credentials without authorization.

When an approved **nonproduction** API credential is available in the process environment (never paste it into chat or logs), an operator may run:

```bash
ZENIX_AI_LIVE_EVAL=true node scripts/aiConversationEval.mjs
```

The model is selected using the configured, priced `ZENIX_AI_MODEL`; the script enforces request and total-cost limits, stops at 40 cases, and requires manual review. It reports a **conservative deterministic relevance rubric** for four unambiguous questions (catalog count, low-stock count, net sales and latest-sale amount). Other 36 cases remain unscored by that rubric pending human annotation. This is *not* a claim of 90% AI accuracy or a complete language benchmark.

For each case examine (a) whether the requested metric was answered, (b) whether unnecessary data appeared, (c) whether the date and authorized store scope match, (d) whether follow-ups use the correct verified entity and do not invent a cause, and (e) whether a restricted or sensitive operation was properly refused or confirmed. Review incorrect answers before choosing a model or promoting a deployment.

CI tests use mocked synthetic model responses and check that the rubric catches a valid-JSON response which answers the **wrong** question; this is categorically different from running a real live model.

### Go/no-go release decision

- Review all 40 synthetic conversations and record model, cost, aggregate answer quality and failure patterns without logging credentials.
- Require zero invented financial amounts, cross-tenant disclosures and unconfirmed writes.
- Compare with the old production behavior on the same synthetic fixtures where feasible; no cherry-picked demonstrations.
- Merge/ship through the established Render deployment workflow only after reviewed quality and backend CI both pass. Keep rollback to the previous backend SHA ready.
