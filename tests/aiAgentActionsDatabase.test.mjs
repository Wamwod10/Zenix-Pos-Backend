import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.AI_AGENT_TEST_DATABASE_URL;
test('P1 receipts use real disposable PostgreSQL with atomic ledger and exact actor scope',{skip:!url,timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url);process.env.DATABASE_URL=url;process.env.NODE_ENV='test';
 const {pool}=await import('../src/db/pool.js');
 const {aiSettings}=await import('../src/config/ai.js');
 const {reserveAi,finishAi}=await import('../src/services/aiQuota.js');
 const {authorizationKey}=await import('../src/services/aiPolicy.js');
 const {runAgentTool}=await import('../src/services/aiAgentTools.js');
 const {confirmAgentAction,cancelAgentAction,getAgentActionStatus}=await import('../src/services/aiAgentActions.js');
 const settings={...aiSettings(),enabled:true,writesEnabled:true};
 async function fixture({metadata={},plan='BUSINESS'}={}){
  const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('AI agent disposable test',$1,'ACTIVE','2099-01-01') RETURNING id",[plan])).rows[0].id;
  const storeId=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Agent branch') RETURNING id",[org])).rows[0].id;
  const warehouseId=(await pool.query('SELECT id FROM warehouses WHERE organization_id=$1 AND store_id=$2 AND is_default',[org,storeId])).rows[0].id;
  const id=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Agent owner',$3,'test-only','OWNER') RETURNING id",[org,storeId,randomUUID()])).rows[0].id;
  const sessionId=(await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[id,randomUUID()])).rows[0].id;
  const productId=(await pool.query("INSERT INTO products(organization_id,name,sku,unit,metadata) VALUES($1,'Rice', $2,'kg',$3) RETURNING id",[org,randomUUID(),metadata])).rows[0].id;
  const user={id,organizationId:org,storeId,sessionId,appRole:'OWNER',permissionOverrides:{},rolePermissions:{}};
  return {user,input:{productId,storeId,warehouseId,quantity:10,unit:'kilo',costPrice:15000,batchNo:null,expiryDate:null}};
 }
 async function prepare(f,{complete=true}={}){
  const requestId=randomUUID(),conversationId=randomUUID();await reserveAi(f.user,requestId,'test-'+requestId,authorizationKey(f.user),settings);
  const response=await runAgentTool(f.user,'prepare_stock_receipt',f.input,{settings,requestId,conversationId});
  if(complete)await finishAi(f.user,requestId,{response:{actions:response.action?[response.action]:[]},cost:0});
  return {response,requestId,conversationId};
 }
 const confirm=(f,a,s=settings)=>confirmAgentAction(f.user,a.id,{confirmationToken:a.confirmationToken},{settings:s});
 const quantity=async f=>Number((await pool.query('SELECT quantity FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3',[f.user.organizationId,f.input.storeId,f.input.productId])).rows[0]?.quantity||0);
 try{
  await t.test('+10 kg once under parallel confirmation, warehouse partition ledger audit and no supplier payment',async()=>{
   const f=await fixture(),{response:{action}}=await prepare(f);assert.equal(action.preview.unit,'kg');assert.equal(await quantity(f),0);
   const [a,b]=await Promise.all([confirm(f,action),confirm(f,action)]);assert.equal(a.action.status,'CONFIRMED');assert.deepEqual(a,b);assert.equal(await quantity(f),10);
   assert.equal(Number((await pool.query('SELECT quantity FROM warehouse_balances WHERE organization_id=$1 AND warehouse_id=$2 AND product_id=$3',[f.user.organizationId,f.input.warehouseId,f.input.productId])).rows[0].quantity),10);
   assert.equal((await pool.query("SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1 AND type='receive'",[f.user.organizationId])).rows[0].n,1);
   assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE organization_id=$1 AND action='receive' AND entity_type='inventory'",[f.user.organizationId])).rows[0].n,1);
   assert.equal((await pool.query('SELECT count(*)::int n FROM supplier_payments WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM supplier_invoices WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
   assert.equal((await getAgentActionStatus(f.user,action.id,{settings})).action.result.delta,10);
  });
  await t.test('decimal stock is verified at database precision and repeated preparation returns same action',async()=>{
   const f=await fixture();f.input={...f.input,quantity:0.2,costPrice:123.45};
   await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,0.1)',[f.user.organizationId,f.input.storeId,f.input.productId]);
   const {response:{action},requestId,conversationId}=await prepare(f,{complete:false});
   const repeated=await runAgentTool(f.user,'prepare_stock_receipt',f.input,{settings,requestId,conversationId});assert.equal(repeated.action.id,action.id);assert.equal(repeated.action.confirmationToken,action.confirmationToken);assert.equal(action.preview.total,24.69);
   await finishAi(f.user,requestId,{response:{actions:[action]},cost:0});const result=await confirm(f,action);assert.equal(result.action.result.after,0.3);assert.equal(await quantity(f),0.3);
  });
  await t.test('prepare and cancellation audit safe previews exactly once without stock effects',async()=>{
   const f=await fixture(),{response:{action},requestId,conversationId}=await prepare(f,{complete:false});
   await runAgentTool(f.user,'prepare_stock_receipt',f.input,{settings,requestId,conversationId});
   await finishAi(f.user,requestId,{response:{actions:[action]},cost:0});
   await Promise.all([1,2].map(()=>cancelAgentAction(f.user,action.id,{confirmationToken:action.confirmationToken},{settings})));
   const audits=(await pool.query("SELECT user_id,store_id,action,metadata FROM audit_logs WHERE organization_id=$1 AND entity_type='ai_agent_action' AND entity_id=$2 ORDER BY created_at",[f.user.organizationId,action.id])).rows;
   assert.deepEqual(audits.map(a=>a.action),['prepare','cancel']);
   for(const audit of audits){assert.equal(audit.user_id,f.user.id);assert.equal(audit.store_id,f.input.storeId);assert.equal(audit.metadata.productId,f.input.productId);assert.equal(audit.metadata.quantity,10);assert.equal(audit.metadata.unit,'kg');assert.equal(audit.metadata.warehouseId,f.input.warehouseId);assert.doesNotMatch(JSON.stringify(audit),/confirmationToken|confirmation_token|payload|session_id/);assert.ok(!JSON.stringify(audit).includes(action.confirmationToken))}
   assert.equal(await quantity(f),0);assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
  });
  await t.test('past expiry dates return clarification without creating an action or stock',async()=>{
   const f=await fixture({metadata:{lotTracking:true,expiryRequired:true}});f.input={...f.input,batchNo:'OLD-BATCH',expiryDate:'2000-01-01'};const {response}=await prepare(f);assert.equal(response.kind,'clarification');assert.equal(response.code,'AI_EXPIRED_STOCK_UNSUPPORTED');assert.equal(await quantity(f),0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM ai_agent_actions WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
  });
  await t.test('foreign actor/session/token and uncompleted request cannot confirm',async()=>{
   const f=await fixture(),other=await fixture(),{response:{action},requestId}=await prepare(f,{complete:false});
   await assert.rejects(()=>confirm(f,action),e=>e.code==='AI_REQUEST_REQUIRED');
   await finishAi(f.user,requestId,{response:{actions:[action]},cost:0});
   await assert.rejects(()=>confirmAgentAction(other.user,action.id,{confirmationToken:action.confirmationToken},{settings}),e=>e.code==='AI_ACTION_NOT_FOUND');
   const newSession=(await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[f.user.id,randomUUID()])).rows[0].id;
   await assert.rejects(()=>confirmAgentAction({...f.user,sessionId:newSession},action.id,{confirmationToken:action.confirmationToken},{settings}),e=>e.code==='AI_ACTION_NOT_FOUND');
   await assert.rejects(()=>confirmAgentAction(f.user,action.id,{confirmationToken:'a'.repeat(43)},{settings}),e=>e.code==='AI_CONFIRMATION_INVALID');
   assert.equal(await quantity(f),0);
  });
  await t.test('expiry, cancellation, stale product and stale warehouse never write stock',async()=>{
   for(const mode of ['expiry','cancel','product','warehouse','archived']){
    const f=await fixture(),{response:{action}}=await prepare(f);
    if(mode==='expiry')await pool.query("UPDATE ai_agent_actions SET expires_at=now()-interval '1 second' WHERE id=$1",[action.id]);
    if(mode==='cancel')await cancelAgentAction(f.user,action.id,{confirmationToken:action.confirmationToken},{settings});
    if(mode==='product')await pool.query("UPDATE products SET name='Changed',updated_at=now() WHERE id=$1",[f.input.productId]);
    if(mode==='archived')await pool.query('UPDATE products SET archived=true WHERE id=$1',[f.input.productId]);
    if(mode==='warehouse')await pool.query("UPDATE warehouses SET name='Changed',updated_at=now() WHERE id=$1",[f.input.warehouseId]);
    assert.equal((await confirm(f,action)).action.status,mode==='expiry'?'EXPIRED':mode==='cancel'?'CANCELLED':'STALE');assert.equal(await quantity(f),0);
    await confirm(f,action);
    const transition=mode==='expiry'?'expire':mode==='cancel'?'cancel':'stale';
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE organization_id=$1 AND entity_type='ai_agent_action' AND entity_id=$2 AND action=$3",[f.user.organizationId,action.id,transition])).rows[0].n,1);
   }
  });
  await t.test('revoked session, permissions, inactive actor, subscription and feature gate checked again',async()=>{
   for(const mode of ['session','permissions','inactive','subscription','plan','gate']){
    const f=await fixture(),{response:{action}}=await prepare(f);
    if(mode==='session')await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[f.user.sessionId]);
    if(mode==='permissions')await pool.query('UPDATE users SET permission_overrides=$2 WHERE id=$1',[f.user.id,{inventoryAdjust:false}]);
    if(mode==='inactive')await pool.query('UPDATE users SET active=false WHERE id=$1',[f.user.id]);
    if(mode==='subscription')await pool.query("UPDATE organizations SET license_status='EXPIRED',expiry_date='2000-01-01' WHERE id=$1",[f.user.organizationId]);
    if(mode==='plan')await pool.query("UPDATE organizations SET plan_code='START' WHERE id=$1",[f.user.organizationId]);
    await assert.rejects(()=>confirm(f,action,mode==='gate'?{...settings,writesEnabled:false}:settings));assert.equal(await quantity(f),0);
   }
  });
  await t.test('missing cost/warehouse, serial/batch tracking and ambiguous search preserve stock',async()=>{
   for(const input of [{costPrice:null},{warehouseId:null}]){const f=await fixture();f.input={...f.input,...input};const {response}=await prepare(f);assert.equal(response.kind,'clarification');assert.equal(await quantity(f),0)}
   for(const metadata of [{trackingMode:'serial'},{trackingMode:'imei'},{lotTracking:true}]){const f=await fixture({metadata}),{response}=await prepare(f);assert.equal(response.kind,'clarification');assert.equal(await quantity(f),0)}
   const f=await fixture();await pool.query("INSERT INTO products(organization_id,name,sku,unit) VALUES($1,'Rice brown',$2,'kg')",[f.user.organizationId,randomUUID()]);
   const matches=await runAgentTool(f.user,'search_products',{query:'Rice'},{settings});assert.equal(matches.candidates.length,2);
   const other=await fixture();await assert.rejects(()=>runAgentTool(f.user,'get_product_stock',{productId:other.input.productId},{settings}),e=>e.code==='PRODUCT_NOT_FOUND');
   await pool.query("UPDATE users SET app_role='WAREHOUSE' WHERE id=$1",[f.user.id]);const branchUser={...f.user,appRole:'WAREHOUSE'};
   await assert.rejects(()=>runAgentTool(branchUser,'get_product_stock',{productId:f.input.productId,storeId:other.input.storeId},{settings}),e=>e.code==='STORE_FORBIDDEN');
   assert.equal((await runAgentTool(branchUser,'list_locations',{}, {settings})).locations.every(l=>l.storeId===f.input.storeId),true);
  });
  await t.test('batch receipt writes exact lot and expiry through the existing receipt service',async()=>{
   const f=await fixture({metadata:{lotTracking:true,expiryRequired:true}});f.input={...f.input,batchNo:'P1-BATCH',expiryDate:'2099-01-01'};const {response:{action}}=await prepare(f);await confirm(f,action);
   const batch=(await pool.query('SELECT batch_no,expiry_date::text,received_quantity FROM inventory_batches WHERE organization_id=$1 AND product_id=$2',[f.user.organizationId,f.input.productId])).rows[0];assert.equal(batch.batch_no,'P1-BATCH');assert.equal(batch.expiry_date,'2099-01-01');assert.equal(Number(batch.received_quantity),10);
  });
  await t.test('failure after receipt writes rolls back stock, ledger, audit and action together',async()=>{
   const f=await fixture(),{response:{action}}=await prepare(f),connect=pool.connect.bind(pool);
   pool.connect=async()=>{const db=await connect(),query=db.query.bind(db),release=db.release.bind(db);db.query=(sql,args)=>{if(String(sql).startsWith('INSERT INTO audit_logs')&&args?.[3]==='confirm')throw Error('Injected audit failure');return query(sql,args)};db.release=(...args)=>{db.query=query;db.release=release;return release(...args)};return db};
   try{await assert.rejects(()=>confirm(f,action),/Injected audit failure/)}finally{pool.connect=connect}
   assert.equal(await quantity(f),0);assert.equal((await getAgentActionStatus(f.user,action.id,{settings})).action.status,'PENDING');
   assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
   assert.equal((await pool.query("SELECT count(*)::int n FROM audit_logs WHERE organization_id=$1 AND action='receive'",[f.user.organizationId])).rows[0].n,0);
  });
 }finally{await pool.end()}
});
