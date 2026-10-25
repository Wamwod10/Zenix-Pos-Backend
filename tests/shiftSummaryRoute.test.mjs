import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../src/routes/shifts.js';
import {pool} from '../src/db/pool.js';

const id='00000000-0000-4000-8000-000000000001';
const shift={id,organization_id:'org',store_id:'store',cashier_id:'cashier',status:'open',opening_cash:'0.10'};
const route=router.stack.find(layer=>layer.route?.path==='/:id/summary').route;
const run=async(user,{found=true}={})=>{
  const calls=[];
  const original=pool.connect;
  pool.connect=async()=>({release(){},query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('SELECT * FROM shifts'))return {rows:found&&params[1]==='org'?[shift]:[]};
    if(sql.includes('cash_sales'))return {rows:[{cash_sales:'0.20',cash_in:'0.30',cash_out:'0.10'}]};
    return {rows:[]};
  }});
  let error,payload,cache;
  const req={params:{id},user};
  const res={set(key,value){cache=[key,value];return this},status(){return this},json(value){payload=value;return this}};
  try{for(const layer of route.stack){await layer.handle(req,res,e=>{error=e});if(error)break}}
  finally{pool.connect=original}
  return {error,payload,calls,cache};
};

test('summary allows assigned cashier and returns decimal-safe authoritative breakdown',async()=>{
  const result=await run({id:'cashier',organizationId:'org',storeId:'store',appRole:'CASHIER'});
  assert.ifError(result.error);
  assert.equal(result.payload.data.summary.expectedCash,0.5);
  assert.deepEqual(result.cache,['Cache-Control','no-store']);
  assert.match(result.calls.find(x=>x.sql.includes('SELECT * FROM shifts')).sql,/FOR SHARE/);
});
for(const [name,user,code] of [
  ['other organization',{id:'cashier',organizationId:'other',storeId:'store',appRole:'CASHIER'},'REQUEST_FAILED'],
  ['other branch',{id:'cashier',organizationId:'org',storeId:'other',appRole:'CASHIER'},'STORE_FORBIDDEN'],
  ['other cashier',{id:'other',organizationId:'org',storeId:'store',appRole:'CASHIER'},'SHIFT_FORBIDDEN'],
  ['missing module permission',{id:'cashier',organizationId:'org',storeId:'store',appRole:'WAREHOUSE'},'FORBIDDEN'],
])test(`summary rejects ${name} before returning financial amounts`,async()=>{
  const result=await run(user);
  assert.equal(result.error?.code,code);
  assert.equal(result.payload,undefined);
  assert.equal(result.calls.some(x=>x.sql.includes('cash_sales')),false);
});
test('reconciliation permission allows another cashier summary',async()=>{
  const result=await run({id:'manager',organizationId:'org',appRole:'MANAGER'});
  assert.ifError(result.error);
  assert.equal(result.payload.data.summary.shiftId,id);
});

test('close refuses cash changed after summary confirmation while holding the shift lock',async()=>{
  const original=pool.connect,calls=[];
  pool.connect=async()=>({release(){},query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('FROM organizations'))return {rows:[{id:'org',timezone:'Asia/Tashkent',license_status:'ACTIVE',expiry_date:'2099-01-01',store_limit:1,settings:{}}]};
    if(sql.includes('SELECT * FROM shifts'))return {rows:[shift]};
    if(sql.includes('SELECT id FROM stores'))return {rows:[{id:'store'}]};
    if(sql.includes('cash_sales'))return {rows:[{cash_sales:'0.20',cash_in:'0.30',cash_out:'0.10'}]};
    return {rows:[]};
  }});
  const close=router.stack.find(layer=>layer.route?.path==='/:id/close').route;
  let error;
  try{
    for(const layer of close.stack){
      await layer.handle({params:{id},body:{actualCash:0.4,expectedCash:0.4},user:{id:'cashier',organizationId:'org',storeId:'store',appRole:'CASHIER'}},{},e=>{error=e});
      if(error)break;
    }
  }finally{pool.connect=original}
  assert.equal(error?.code,'SHIFT_CASH_CHANGED');
  assert.equal(error?.details.expectedCash,0.5);
  const locked=calls.findIndex(x=>x.sql.includes('SELECT * FROM shifts')&&x.sql.includes('FOR UPDATE'));
  assert.ok(locked>=0&&locked<calls.findIndex(x=>x.sql.includes('cash_sales')));
  assert.equal(calls.some(x=>x.sql.includes('UPDATE shifts')),false);
  assert.equal(calls.at(-1).sql,'ROLLBACK');
});
