import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db/pool.js';
import router from '../src/routes/warehouses.js';
import {setInventoryWarehouse} from '../src/services/warehouses.js';

const org='11111111-1111-4111-8111-111111111111',store='22222222-2222-4222-8222-222222222222',warehouse='33333333-3333-4333-8333-333333333333';
const handle=(path,method)=>router.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]).route.stack.at(-1).handle;

test('warehouse context rejects a location belonging to another branch before setting transaction state',async()=>{
  const calls=[];const db={query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};}};
  await assert.rejects(setInventoryWarehouse(db,{organizationId:org,storeId:store,warehouseId:warehouse}),error=>error.code==='WAREHOUSE_NOT_FOUND');
  assert.equal(calls.length,1);assert.deepEqual(calls[0].args,[org,store,warehouse]);
});
test('warehouse context is transaction-local and tenant-scoped',async()=>{
  const calls=[];const db={query:async(sql,args)=>{calls.push({sql,args});return {rows:[{id:warehouse}]};}};
  await setInventoryWarehouse(db,{organizationId:org,storeId:store,warehouseId:warehouse});
  assert.match(calls[1].sql,/set_config.*true/);assert.deepEqual(calls[1].args,[warehouse]);
});
test('branch-locked warehouse listing cannot read another branch',async()=>{
  let error;await handle('/','get')({query:{storeId:store},user:{organizationId:org,storeId:warehouse,appRole:'WAREHOUSE'}},{},failure=>{error=failure});
  assert.equal(error?.code,'STORE_FORBIDDEN');
});
test('warehouse listing returns only requested tenant and branch balances',async()=>{
  const original=pool.query,calls=[];pool.query=async(sql,args)=>{calls.push({sql,args});return {rows:sql.includes('FROM stores')?[{id:store}]:[]};};
  try{let result,error;await handle('/','get')({query:{storeId:store},user:{organizationId:org,appRole:'OWNER'}},{status(){return this},json(value){result=value}},failure=>{error=failure});assert.ifError(error);assert.deepEqual(result.data,{warehouses:[],balances:[]});assert.ok(calls.every(call=>call.args.includes(org)&&call.args.includes(store)));}finally{pool.query=original;}
});
