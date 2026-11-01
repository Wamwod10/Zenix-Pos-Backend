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
