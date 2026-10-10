import test from 'node:test';
import assert from 'node:assert/strict';
import {pool} from '../src/db/pool.js';
import sales from '../src/routes/sales.js';
import shifts from '../src/routes/shifts.js';
import stores from '../src/routes/stores.js';
import bootstrap from '../src/routes/bootstrap.js';
import * as auth from '../src/routes/auth.js';

const ORG='22222222-2222-4222-8222-222222222222';
const STORE='33333333-3333-4333-8333-333333333333';
const ID='44444444-4444-4444-8444-444444444444';
const handler=(router,path,method)=>router.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]).route.stack.at(-1).handle;

for(const [path,method,body] of [['/','post',{name:'New branch'}],['/:id','patch',{active:true}]]){
  for(const extra of [0,1])test(`store ${method} enforces effective capacity with ${extra} active extra pass`,async()=>{
    const originalConnect=pool.connect;
    let written=false;
    const query=async(sql)=>{
      if(sql.includes('FROM organizations'))return {rows:[{id:ORG,license_status:'ACTIVE',expiry_date:'9999-12-31',store_limit:1,timezone:'Asia/Tashkent',settings:{}}]};
      if(sql.includes('FROM extra_store_entitlements'))return {rows:[{count:extra}]};
      if(sql.includes('count(*)'))return {rows:[{count:1}]};
      if(sql.includes('SELECT * FROM stores'))return {rows:[{id:STORE,name:'Archived',active:false}]};
      if(sql.includes('SELECT 1 FROM stores'))return {rows:[],rowCount:0};
      if(/INSERT|UPDATE stores/.test(sql))written=true;
      return {rows:[{id:STORE,name:'Restored',active:true}],rowCount:1};
    };
    pool.connect=async()=>({query,release(){}});
    try{
      let failure,result;
      await handler(stores,path,method)({body,params:{id:STORE},user:{id:ID,organizationId:ORG,appRole:'OWNER'}},{status(){return this},json(value){result=value}},error=>{failure=error});
      if(extra===0){assert.equal(failure?.code,'STORE_LIMIT');assert.equal(written,false);}
      else{assert.ifError(failure);assert.equal(written,true);assert.equal(result.data.store.active,true);}
    }finally{pool.connect=originalConnect;}
  });
}

for(const [router,path,method,body] of [
  [sales,'/','post',{storeId:STORE,shiftId:ID,items:[{productId:ID,quantity:1,unitPrice:10}],payments:[{method:'cash',amount:10}]}],
  [sales,'/holds','post',{storeId:STORE,name:'Held cart',cart:[{id:ID,cartQty:1}],total:0}],
  [sales,'/holds/:id','delete',{}],
  [sales,'/business-days/close','post',{storeId:STORE,businessDate:'2026-10-09'}],
  [sales,'/:id/returns','post',{productId:ID,quantity:1,reason:'Return'}],
  [shifts,'/open','post',{storeId:STORE}],
  [shifts,'/:id/movements','post',{type:'in',amount:10,reason:'Cash in'}],
  [shifts,'/:id/close','post',{actualCash:0}],
  [stores,'/','post',{name:'New branch'}],
  [stores,'/:id','patch',{name:'Renamed'}],
])for(const [state,code] of [
  [{license_status:'SUSPENDED'},'ACCOUNT_SUSPENDED'],
  [{settings:{billingHold:true}},'BILLING_HOLD'],
  [{license_status:'PAYMENT_REQUIRED'},'PAYMENT_REQUIRED'],
  [{expiry_date:'2000-01-01'},'LICENSE_EXPIRED'],
]){
  test(`${method} ${path} revalidates ${code} before any protected write`,async()=>{
    const originalConnect=pool.connect,originalQuery=pool.query;
    let written=false;
    const query=async(sql)=>{
      if(sql.includes('FROM organizations'))return {rows:[{id:ORG,license_status:'ACTIVE',expiry_date:'9999-12-31',store_limit:2,timezone:'Asia/Tashkent',settings:{},...state}]};
      if(/^BEGIN|^ROLLBACK|^COMMIT/.test(sql))return {rows:[]};
      if(/INSERT|UPDATE|DELETE/.test(sql.replace(/FOR UPDATE/g,'')))written=true;
      if(sql.includes('FROM stores'))return {rows:[{id:STORE,active:true,name:'Main'}],rowCount:1};
      if(sql.includes('FROM shifts'))return {rows:[{id:ID,store_id:STORE,organization_id:ORG,cashier_id:ID,status:'open'}],rowCount:1};
      if(sql.includes('FROM sale_holds')||sql.includes('FROM sales'))return {rows:[{id:ID,store_id:STORE}],rowCount:1};
      return {rows:[],rowCount:0};
    };
    pool.connect=async()=>({query,release(){}});pool.query=query;
    try{
      let failure;
      const res={status(){return this},json(){}};
      await handler(router,path,method)({body,params:{id:ID},user:{id:ID,organizationId:ORG,appRole:'OWNER',name:'Owner'}},res,error=>{failure=error});
      assert.equal(failure?.code,code);
      assert.equal(written,false);
    }finally{pool.connect=originalConnect;pool.query=originalQuery;}
  });
}

test('bootstrap labels historical and future entitlements inactive without adding capacity',async()=>{
  const original=pool.query;
  pool.query=async(sql)=>{
    if(sql.includes('FROM organizations'))return {rows:[{id:ORG,license_status:'PAYMENT_REQUIRED',store_limit:1,timezone:'Asia/Tashkent',settings:{}}]};
    if(sql.includes('SUM(quantity)'))return {rows:[{count:0}]};
    if(sql.includes('FROM extra_store_entitlements'))return {rows:[{quantity:1,starts_on:'2000-01-01',expires_on:'2000-02-01'},{quantity:2,starts_on:'9999-01-01',expires_on:'9999-02-01'}]};
    return {rows:[]};
  };
  try{
    let body,failure;
    await handler(bootstrap,'/','get')({user:{organizationId:ORG,appRole:'OWNER'}},{status(){return this},json(value){body=value}},error=>{failure=error});
    assert.ifError(failure);
    assert.equal(body.data.organization.storeLimit,1);
    assert.deepEqual(body.data.organization.extraStoreEntitlements.map(row=>row.status),['INACTIVE','INACTIVE']);
  }finally{pool.query=original;}
});

test('bootstrap expiry-day and not-yet-started entitlements never increase capacity',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-08T20:00:00Z')});
  const original=pool.query;
  pool.query=async(sql)=>{
    if(sql.includes('FROM organizations'))return {rows:[{id:ORG,license_status:'PAYMENT_REQUIRED',store_limit:1,timezone:'Asia/Tashkent',settings:{}}]};
    if(sql.includes('FROM extra_store_entitlements'))return {rows:[
      {quantity:5,starts_on:'2026-09-09',expires_on:'2026-10-09'},
      {quantity:5,starts_on:'2026-10-10',expires_on:'2026-11-10'},
      {quantity:2,starts_on:'2026-10-09',expires_on:'2026-11-09'},
    ]};
    return {rows:[]};
  };
  try{
    let body,failure;
    await handler(bootstrap,'/','get')({user:{organizationId:ORG,appRole:'OWNER'}},{status(){return this},json(value){body=value}},error=>{failure=error});
    assert.ifError(failure);
    assert.equal(body.data.organization.storeLimit,3);
    assert.equal(body.data.organization.activeExtraStores,2);
    assert.deepEqual(body.data.organization.extraStoreEntitlements.map(row=>row.status),['INACTIVE','INACTIVE','ACTIVE']);
  }finally{pool.query=original;}
});

test('trial dates use the organization calendar across UTC midnight',()=>{
  assert.equal(typeof auth.trialPeriod,'function');
  assert.equal(auth.trialPeriod({timezone:'Asia/Tashkent'},new Date('2026-10-08T20:00:00Z')).expiryDate,'2026-10-23');
  assert.equal(auth.trialPeriod({timezone:'America/Los_Angeles'},new Date('2026-10-09T01:00:00Z')).expiryDate,'2026-10-22');
});

test('registration persists trial expiry from the returned organization timezone',async(t)=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-09T01:00:00Z')});
  const originalConnect=pool.connect,originalQuery=pool.query;
  let expiryDate;
  const query=async(sql,params)=>{
    if(sql.startsWith('INSERT INTO organizations'))return {rows:[{id:ORG,name:'Business',timezone:'America/Los_Angeles',created_at:new Date()}],rowCount:1};
    if(sql.startsWith('UPDATE organizations'))expiryDate=params[3];
    if(sql.startsWith('INSERT INTO stores'))return {rows:[{id:STORE}],rowCount:1};
    return {rows:[{id:ID,organization_id:ORG,store_id:STORE,app_role:'OWNER',name:'Owner'}],rowCount:1};
  };
  pool.connect=async()=>({query,release(){}});pool.query=query;
  try{
    let failure;
    const req={body:{businessName:'Business',ownerName:'Owner',phone:'+998901234567',username:'owner-task5',password:'test-password',startOption:'TRIAL'},ip:'127.0.0.1',get(){return 'Test'}};
    await handler(auth.default,'/register','post')(req,{cookie(){return this},status(){return this},json(){}},error=>{failure=error});
    assert.ifError(failure);assert.equal(expiryDate,'2026-10-22');
  }finally{pool.connect=originalConnect;pool.query=originalQuery;}
});
