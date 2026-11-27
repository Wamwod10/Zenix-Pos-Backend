# Loyalty redemption release contract — 2026-11-27

This branch is a non-operational calculation foundation. The currently released accrual and reversal rules remain unchanged. No checkout endpoint, setting, migration, or production write is enabled here.

## Proposed product policy (requires review before activation)
- Separate non-cash loyalty tender, not cash/card/transfer; explicit organization opt-in, value in whole UZS per point and maximum eligible sale share in basis points. No default conversion rate or implicit activation. First release should disallow credit + loyalty and offline redemption.
- Only whole available points are spendable. Negative balances allow zero redemption. The backend must compute the quote from confirmed prices, active customer, tenant-wide ledger, and current settings; never trust a supplied balance, rate or converted money amount.
- No earning on redeemed value; preserve historical rates on the sale. Return restores the originally spent points cumulatively and proportionally, while reversing original earned points based on the original eligible amount. Never refund loyalty tender as cash. Policy for partial returns and rate changes must be made explicit before implementation.

## Transaction and integration gates
1. Inspect constraints on sale_payments, customer_loyalty_ledger, and all report aggregations. Introduce a backward-compatible typed tender/ledger schema only after migration rehearsal.
2. Under existing organization lock, lock customer in the same order as sale/return paths, recompute quote and validate permissions/branch scope, write redemption with sale/stock/tenders/audit in one transaction. Require replay fingerprint and unique operation key; no second debit on timeout/retry.
3. Update original/manual refund allocation, cash shift and business day totals, finance/P&L policy, analytics, Telegram notifications, receipts, sales history, customer display, checkout and CSV. Keep non-cash tender separate from cash expected.
4. Build owner configuration, server quote endpoint, both POS paths, balance display and retry handling. Do not expose configuration until the backend and reporting contract are complete.
5. Disposable DB and synthetic browser gates: cross-tenant/branch denial, concurrent spending, insufficient balance, inactive customer, disabled policy, price/policy changes, partial/full returns, original/manual refund constraints, rollback, idempotency, mixed payment reconciliation and historical reports. No production test transactions.

## Integration update
Draft checkout now includes an explicit loyalty tender, quote and transaction-scoped debit; only original-tender refund is accepted. Partial returns allocate cents proportionally, restore points cumulatively at ledger precision (0.01 point), and restore the full original debit on a full return. Accrual uses monetary spend only. Cashflow excludes loyalty; finance reports expose separate captured/refunded/net loyalty tender. Revenue remains the sale-document value, not a tax/accounting conclusion: confirm accounting treatment before enabling. HTTP and disposable PostgreSQL test added; production activation and all UI/report consumers remain gated.
