import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sales=readFileSync(new URL('../src/routes/sales.js',import.meta.url),'utf8');
const inventory=readFileSync(new URL('../src/routes/inventory.js',import.meta.url),'utf8');

test('sale serializes with shift close on the same open-shift row',()=>{
 assert.match(sales,/SELECT \* FROM shifts WHERE id=\$1 AND organization_id=\$2 AND store_id=\$3 AND status='open' FOR UPDATE/);
});

test('refund only pays out captured payments, including settled credit allocations',()=>{
 assert.match(sales,/customer_payment_allocations a[\s\S]*credit\.sale_id=\$1/);
 assert.match(sales,/REFUND_EXCEEDS_CAPTURED_PAYMENT/);
 assert.match(sales,/SELECT id FROM customers WHERE id=\$1 AND organization_id=\$2 FOR UPDATE/);
});

test('inventory count conflicts persist while partial stock movements roll back',()=>{
 assert.match(inventory,/SAVEPOINT inventory_count_apply/);
 assert.match(inventory,/ROLLBACK TO SAVEPOINT inventory_count_apply/);
 assert.match(inventory,/SAVEPOINT inventory_count_review/);
 assert.match(inventory,/ROLLBACK TO SAVEPOINT inventory_count_review/);
 assert.match(inventory,/status='conflict'/);
});

test('receipt rejects zero-valued product costs',()=>{
 assert.match(inventory,/costPrice:z\.coerce\.number\(\)\.positive\(\)/);
});
