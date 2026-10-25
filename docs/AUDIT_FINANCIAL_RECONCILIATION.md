# Financial reconciliation remediation

## Implemented contracts

- Customer financial profile writes require `customerFinancialWrite`: OWNER/ADMIN by default; MANAGER/CASHIER/SALES/WAREHOUSE need an explicit grant. Contact edits retain existing module permissions. Unchanged financial values in legacy full-form submissions remain permitted; omitted values are preserved.
- Customer repayment requires a stable `clientReference`. Cash additionally requires `storeId`, `shiftId`, shift permission, the cashier's shift or `shiftRecon`, and the active matching register. Ledger, FIFO allocations, cash movement and audit commit atomically. A completed identical retry returns the prior payment even after shift close; changed intent/actor conflicts.
- Card/transfer repayments never create cash movements. New cash provenance is constrained by composite tenant foreign keys, unique references and deferred reciprocal consistency checks. Historical unlinked rows are untouched.
- Supplier invoice creation requires `clientReference`; identical concurrent requests return one invoice/payment/audit/notification. Intent, supplier, store or actor changes conflict. Initial settlement preserves existing external-payment semantics.
- `GET /api/shifts/:id/summary` provides server-authoritative opening cash, cash sales, cash in/out and expected cash. Close may submit `expectedCash`; a changed snapshot returns `SHIFT_CASH_CHANGED` rather than silently accepting stale reconciliation. Old callers omitting this value retain server-side calculation.

## Reconciliation equation

`expectedCash = openingCash + cash sale_payments + incoming shift_movements - outgoing shift_movements`

Sales and movements are aggregated separately in PostgreSQL NUMERIC to avoid join multiplication. Refund, expense, supplier payment, customer repayment and manual movements use their existing signed movement sources. Card/transfer sales do not inflate cash. Final monetary comparisons use cent precision.

## Evidence

- Real PostgreSQL fixtures: 1/100/3000/5000/10000 sales with mixed payment methods and six movement sources; independent SQL agrees with the API calculation.
- Parallel identical customer repayment creates one ledger/allocation/movement; parallel distinct overpayments serialize on the customer. Injected failures roll back writes. Deferred constraints reject missing, detached, mismatched or duplicated cash provenance.
- HTTP role matrix, cross-tenant/store checks, closed-shift replay, stale close rejection and supplier invoice duplicate submission are exercised by named remediation tests.
- Customer overdue dates now use the organization's calendar timezone; sales/refunds honor branch business-day cutoffs. Expense report grouping uses that branch cutoff too.
- Two-branch real PostgreSQL receipt/catalog test: branch A opens with10 units at zero cost while global reference is99; receiving10 at20 produces average10, while branch B stays at15. Branch cost maps drive frontend valuation; zero is preserved. Prospective sale item/movement snapshots now use nullish fallback rather than treating zero as missing. Historical snapshots remain unchanged.

## Decisions still required

1. Refund KPI attribution differs between report paths: original seller versus refund operator. No historical attribution/formula rewrite was guessed.
2. Expense selected date versus posting `created_at` needs an approved accounting policy. Reports still derive posting day from timestamp; changing timezone/cutoff may regroup historical expenses. No historical backfill was performed.
3. Transfer dispatch lacks a historical cost snapshot; receive/return weighted-average costing policy needs a separate migration/business decision. Do not claim all multi-branch valuation paths reconciled.
4. Supplier initial cash settlement and advance-payment provenance must distinguish external money from drawer money; existing external semantics were retained. Multi-invoice allocation history remains a separate gap.
5. Other legacy financial endpoints still allow omitted replay references. The new mandatory-reference contract applies to customer repayments and supplier invoice creation only.

## Performance limits

Large fixture creation was slow on this Windows embedded PostgreSQL environment (one repeated volume run took about 536 seconds). This is not a controlled before/after production benchmark. No performance improvement claim is made; production load and 20-cashier stress remain unverified unless explicitly covered by the final test report.

A later serialized run seeded10000 mixed-payment sales in2017ms and calculated the authoritative summary in28.5ms. The existing10000-customer/sales directory test reported57ms for a bounded100-row page. These are single local observations; concurrent production performance and before/after improvements are not established.
