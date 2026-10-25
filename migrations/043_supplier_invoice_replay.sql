-- Extend completed-outcome replay protection; no historical invoice changes.
ALTER TABLE financial_write_replays DROP CONSTRAINT financial_write_replays_operation_check;
ALTER TABLE financial_write_replays ADD CONSTRAINT financial_write_replays_operation_check
 CHECK(operation IN ('supplier_payment','expense_create','supplier_invoice_create'));
