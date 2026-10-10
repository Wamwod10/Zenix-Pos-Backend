import test from 'node:test';import assert from 'node:assert/strict';
import * as inventory from '../src/routes/inventory.js';
test('count reconciliation records deterministic lot reductions and unknown-origin surplus',async()=>{
 assert.equal(typeof inventory.reconcileCountBatches,'function');
 const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return {rows:sql.includes('SELECT id,remaining_quantity')?[{id:'first',remaining_quantity:'10.000'},{id:'second',remaining_quantity:'20.000'}]:[{id:'new-lot'}]}}};
 const tracking=await inventory.reconcileCountBatches(client,{organizationId:'org',storeId:'store',productId:'product',requestedBalance:'15.000'});
 assert.deepEqual(tracking,{policy:'FEFO_FIFO',batches:[{id:'first',before:'10.000',after:'0.000',delta:'-10.000'},{id:'second',before:'20.000',after:'15.000',delta:'-5.000'}]});
 assert.match(calls[0].sql,/expiry_date ASC NULLS LAST,created_at ASC,id ASC FOR UPDATE/);
 const surplus=await inventory.reconcileCountBatches(client,{organizationId:'org',storeId:'store',productId:'product',requestedBalance:'35.000'});
 assert.equal(surplus.batches[0].origin,'UNKNOWN');assert.equal(surplus.batches[0].expiryDate,null);
});
