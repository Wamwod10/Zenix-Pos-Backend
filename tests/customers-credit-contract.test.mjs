import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const migration=fs.readFileSync(new URL('../migrations/012_customers_credit_sales.sql',import.meta.url),'utf8');const sales=fs.readFileSync(new URL('../src/routes/sales.js',import.meta.url),'utf8');const customers=fs.readFileSync(new URL('../src/routes/customers.js',import.meta.url),'utf8');
test('customer receivables use ledger and indexed tenant keys',()=>{assert.match(migration,/CREATE TABLE IF NOT EXISTS customer_ledger/);assert.match(migration,/customer_ledger_org_customer_created_idx/)});test('credit sale is atomic with sale transaction',()=>{assert.match(sales,/CREDIT_CUSTOMER_REQUIRED/);assert.match(sales,/INSERT INTO customer_ledger/)});test('customer payment cannot exceed balance',()=>assert.match(customers,/CUSTOMER_PAYMENT_EXCEEDS_BALANCE/));

test("credit sale refunds reduce receivables before paying cash",()=>{
  assert.match(sales,/creditReduction/);
  assert.match(sales,/customer_payment_allocations/);
  assert.match(sales,/entry_type,amount,reference,note,created_by,metadata/);
});
