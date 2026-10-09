import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStoreWithinPaidCapacity,lockStoreTradingAuthorization } from '../src/services/storeTradingHolds.js';

const A='11111111-1111-4111-8111-111111111111';
const stores=['a','b','c'];
function fakeClient({limit=2,extra=0,held={}}={}){
  const calls=[];
  const client={query:async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql.includes('FROM organizations'))return {rows:[{id:A,store_limit:limit,timezone:'Asia/Tashkent',license_status:'ACTIVE',expiry_date:'9999-12-31',settings:{storeTradingHolds:held}}]};
    if(sql.includes('FROM extra_store_entitlements'))return {rows:[{count:extra}]};
    if(sql.includes('FROM stores'))return {rows:stores.map(id=>({id}))};
    throw new Error('Unexpected query: '+sql);
  }};
  return {client,calls};
}
test('an expired extra-store pass blocks only new operations at the excess store',async()=>{
  const {client,calls}=fakeClient({limit:2,extra:0});
  await lockStoreTradingAuthorization(client,A,'a');
  await lockStoreTradingAuthorization(client,A,'b');
  await assert.rejects(()=>lockStoreTradingAuthorization(client,A,'c'),e=>e.code==='STORE_ENTITLEMENT_EXPIRED'&&e.status===402);
  assert.match(calls[0].sql,/FOR UPDATE/);
  assert.deepEqual(calls.at(-1).params,[A]);
});
test('a paid extra-store pass permits the additional branch without changing base limit',async()=>{
  const {client}=fakeClient({limit:2,extra:1});
  assert.deepEqual(await assertStoreWithinPaidCapacity(client,{id:A,store_limit:2,timezone:'Asia/Tashkent'},'c'),{allowed:3,position:2});
});
test('expired pass never deletes inventory or store rows and does not allow an unknown store',async()=>{
  const {client,calls}=fakeClient({limit:1});
  await assert.rejects(()=>assertStoreWithinPaidCapacity(client,{id:A,store_limit:1,timezone:'Asia/Tashkent'},'z'),{code:'STORE_INACTIVE'});
  assert.ok(calls.every(({sql})=>/SELECT/i.test(sql) && !/DELETE|UPDATE|INSERT/i.test(sql)));
});
test('explicit admin hold takes precedence over the base capacity',async()=>{
  const {client}=fakeClient({limit:3,extra:0,held:{a:{reason:'admin hold'}}});
  await assert.rejects(()=>lockStoreTradingAuthorization(client,A,'a'),{code:'STORE_TRADING_HOLD'});
});
