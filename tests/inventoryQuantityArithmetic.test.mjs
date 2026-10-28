import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sumInventoryQuantity} from '../src/lib/inventoryNumeric.js';

test('inventory balances preserve exact thousandths through signed adjustments',()=>{
 for(const [values,expected] of [
  [['10.200','0.100'],10.3],
  [['0.100','0.200'],0.3],
  [['10.000','-0.125'],9.875],
  [['9.875','0.125'],10],
  [['0.001','-0.001'],0],
  [['3.333','0.002'],3.335],
 ]) assert.equal(sumInventoryQuantity(values),expected,values.join('+'));
});

test('inventory sum rejects quantities beyond exact JS numeric transport bounds',()=>{
 assert.throws(()=>sumInventoryQuantity(['9007199254740.991','0.001']),error=>error.code==='INVENTORY_NUMERIC_LIMIT');
 assert.throws(()=>sumInventoryQuantity(['0.001','0.0001']),error=>error.code==='INVENTORY_NUMERIC_LIMIT');
});

test('inventory routes use exact decimal snapshots for dispatch, receiving, cancellation and adjustment',()=>{
 const source=readFileSync(new URL('../src/routes/inventory.js',import.meta.url),'utf8');
 for(const code of [
  'sumInventoryQuantity([balance.quantity,-sentQuantity])',
  'sumInventoryQuantity([balance.quantity,input.delta])',
  'sumInventoryQuantity([balance.quantity,received])',
  'sumInventoryQuantity([balance.quantity,line.sent_quantity])',
 ]) assert.ok(source.includes(code),code);
});
