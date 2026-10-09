import test from 'node:test';
import assert from 'node:assert/strict';
import {assertStoreCanTrade,lockStoreTradingAuthorization,changeStoreTradingHold} from '../src/services/storeTradingHolds.js';

const ORG='22222222-2222-4222-8222-222222222222';
const STORE='33333333-3333-4333-8333-333333333333';
const ACTOR='44444444-4444-4444-8444-444444444444';
const reason='Qo‘shimcha filial to‘lovi tugagan';

function fakeDb(settings={}) {
  const calls=[];
  const client={query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT id,settings') && sql.includes('FROM organizations'))return {rows:[{id:ORG,settings,store_limit:2,timezone:'Asia/Tashkent',license_status:'ACTIVE',expiry_date:'9999-12-31'}]};
    if(sql.includes('FROM extra_store_entitlements'))return {rows:[{count:0}]};
    if(sql.startsWith('SELECT id FROM stores'))return {rows:[{id:STORE}]};
    if(sql.startsWith('SELECT id,name,active FROM stores'))return {rows:[{id:STORE,name:'Market 2',active:true}]};
    return {rows:[],rowCount:1};
  }};
  return {client,calls};
}

test('new POS writes are blocked only for explicitly held stores',()=>{
  const org={settings:{storeTradingHolds:{[STORE]:{reason,at:'2026-10-08T00:00:00Z'}}}};
  assert.throws(()=>assertStoreCanTrade(org,STORE),error=>error?.code==='STORE_TRADING_HOLD'&&error?.status===423);
  assert.doesNotThrow(()=>assertStoreCanTrade(org,'other-store'));
  assert.doesNotThrow(()=>assertStoreCanTrade({settings:{}},STORE));
});
test('new sale gets the org row lock before reading hold state',async()=>{
  const {client,calls}=fakeDb({});
  await lockStoreTradingAuthorization(client,ORG,STORE);
  assert.match(calls[0].sql,/FOR UPDATE/);
  assert.deepEqual(calls[0].params,[ORG]);
});
test('transaction refuses a held sale without further writes',async()=>{
  const {client,calls}=fakeDb({storeTradingHolds:{[STORE]:{reason}}});
  await assert.rejects(()=>lockStoreTradingAuthorization(client,ORG,STORE),{code:'STORE_TRADING_HOLD'});
  assert.equal(calls.length,1); // explicit admin hold must short-circuit entitlement lookups
});
test('platform admin can hold and release same store with audit',async()=>{
  const {client,calls}=fakeDb({});
  const hold=await changeStoreTradingHold(client,{organizationId:ORG,storeId:STORE,actorId:ACTOR,action:'HOLD',reason});
  assert.equal(hold.held,true);
  const stored=JSON.parse(calls.find(c=>c.sql.startsWith('UPDATE organizations')).params[1]);
  assert.equal(stored.storeTradingHolds[STORE].reason,reason);
  assert.ok(calls.some(c=>c.sql.includes('INSERT INTO audit_logs')));
  const {client:release,calls:releaseCalls}=fakeDb(stored);
  assert.equal((await changeStoreTradingHold(release,{organizationId:ORG,storeId:STORE,actorId:ACTOR,action:'RELEASE',reason})).held,false);
  assert.deepEqual(JSON.parse(releaseCalls.find(c=>c.sql.startsWith('UPDATE organizations')).params[1]).storeTradingHolds,{});
});
test('invalid action, missing reason and double hold fail closed',async()=>{
  const {client}=fakeDb({storeTradingHolds:{[STORE]:{reason}}});
  await assert.rejects(()=>changeStoreTradingHold(client,{organizationId:ORG,storeId:STORE,actorId:ACTOR,action:'HOLD',reason}),{code:'STORE_ALREADY_HELD'});
  await assert.rejects(()=>changeStoreTradingHold(client,{organizationId:ORG,storeId:STORE,actorId:ACTOR,action:'HOLD',reason:'short'}),{code:'REASON_REQUIRED'});
  await assert.rejects(()=>changeStoreTradingHold(client,{organizationId:ORG,storeId:STORE,actorId:ACTOR,action:'DELETE',reason}),{code:'INVALID_HOLD_ACTION'});
});

for (const [state,code] of [
  [{license_status:'SUSPENDED'},'ACCOUNT_SUSPENDED'],
  [{settings:{billingHold:true}},'BILLING_HOLD'],
  [{license_status:'PAYMENT_REQUIRED'},'PAYMENT_REQUIRED'],
  [{license_status:'REVIEW'},'LICENSE_REVIEW'],
  [{expiry_date:'2026-10-08'},'LICENSE_EXPIRED'],
]) {
  test(`locked authorization rejects committed ${code} before a business write`,async()=>{
    let written=false;
    const client={query:async(sql)=>{
      if(sql.includes('FROM organizations'))return {rows:[{id:ORG,license_status:'ACTIVE',expiry_date:'2026-10-09',timezone:'Asia/Tashkent',store_limit:1,settings:{},...state}]};
      if(sql.includes('FROM extra_store_entitlements'))return {rows:[{count:0}]};
      if(sql.includes('FROM stores'))return {rows:[{id:STORE}]};
      written=true;return {rows:[]};
    }};
    await assert.rejects(async()=>{
      await lockStoreTradingAuthorization(client,{organizationId:ORG,storeId:STORE,now:new Date('2026-10-08T20:00:00Z')});
      await client.query('INSERT INTO sales');
    },error=>error.code===code && Boolean(error.message));
    assert.equal(written,false);
  });
}

test('locked timezone drives inclusive license date and the exact entitlement lookup date',async()=>{
  let entitlementDate;
  const client={query:async(sql,params)=>{
    if(sql.includes('FROM organizations'))return {rows:[{id:ORG,license_status:'ACTIVE',expiry_date:'2026-10-09',timezone:'Asia/Tashkent',store_limit:1,settings:{}}]};
    if(sql.includes('FROM extra_store_entitlements')){entitlementDate=params[1];return {rows:[{count:0}]};}
    return {rows:[{id:STORE}]};
  }};
  const result=await lockStoreTradingAuthorization(client,{organizationId:ORG,storeId:STORE,now:new Date('2026-10-08T20:00:00Z')});
  assert.equal(result.businessDate,'2026-10-09');
  assert.equal(result.effectiveStoreLimit,1);
  assert.equal(entitlementDate,'2026-10-09');
});
