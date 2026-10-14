import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.AI_AGENT_TEST_DATABASE_URL;
test('agent conversations and quota preserve actor scope on disposable PostgreSQL',{skip:!url,timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url);process.env.NODE_ENV='test';process.env.DATABASE_URL=url;
 const {pool}=await import('../src/db/pool.js');
 const {aiAgentChat}=await import('../src/services/aiAgentChat.js');
 const {aiSettings,tokenCostMicros}=await import('../src/config/ai.js');
 const {confirmAgentAction}=await import('../src/services/aiAgentActions.js');
 const settings={...aiSettings(),enabled:true,writesEnabled:true,userPerMinute:10,businessPerMinute:30};
 async function fixture(){
  const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Agent conversation test','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Asosiy filial') RETURNING id",[org])).rows[0].id;
  const warehouse=(await pool.query('SELECT id FROM warehouses WHERE organization_id=$1 AND store_id=$2',[org,store])).rows[0].id;
  const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Agent tester',$3,'test','OWNER') RETURNING id",[org,store,randomUUID()])).rows[0].id;
  const session=(await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[user,randomUUID()])).rows[0].id;
  const product=(await pool.query("INSERT INTO products(organization_id,name,unit,cost_price) VALUES($1,'Guruch','kg',1000) RETURNING id",[org])).rows[0].id;
  return {user:{id:user,organizationId:org,sessionId:session,storeId:store,appRole:'OWNER',permissionOverrides:{},rolePermissions:{}},store,warehouse,product};
 }
 const body=(question,extra={})=>({requestId:randomUUID(),question,...extra});
 const final=()=>({calls:[],items:[],reply:{kind:'greeting',reply:'Salom! Biznesingiz haqida so‘rashingiz mumkin.'},inputTokens:100,outputTokens:20,cost:tokenCostMicros(100,20)});
 const call=(name,args)=>{const callId=randomUUID();return {...final(),reply:null,calls:[{callId,name,args}],items:[{type:'function_call',status:'completed',name,call_id:callId,arguments:JSON.stringify(args)}]}};
 const providerFor=responses=>async(_history,{onDispatch})=>{await onDispatch();return responses.shift()};
 try{
  await t.test('free conversation stores context, replay charges once, no client history',async()=>{
   const f=await fixture(),input=body('Biznesimni qanday yaxshilasam bo‘ladi?',{storeId:f.store});
   const first=await aiAgentChat(f.user,input,{settings,provider:providerFor([final()])});
   const replay=await aiAgentChat(f.user,input,{settings,provider:async()=>{throw Error('must not dispatch')}});assert.deepEqual(replay,first);
   let history;
   await aiAgentChat(f.user,body('Davom ettiring',{conversationId:first.conversationId,storeId:f.store}),{settings,provider:async(h,{onDispatch})=>{history=h;await onDispatch();return final()}});
   assert.ok(history.some(h=>h.content===input.question));
   const successes=(await pool.query('SELECT successes FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0].successes;assert.equal(successes,2);
   await assert.rejects(()=>aiAgentChat(f.user,body('salom',{organizationId:f.user.organizationId,recentQuestions:['other tenant']}),{settings,provider:providerFor([final()])}));
  });
  await t.test('tenant, session, branch and concurrent context are isolated',async()=>{
   const a=await fixture(),b=await fixture();
   const first=await aiAgentChat(a.user,body('Salom',{storeId:a.store}),{settings,provider:providerFor([final()])});
   for(const [user,store] of [[b.user,b.store],[{...a.user,sessionId:(await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[a.user.id,randomUUID()])).rows[0].id},a.store],[a.user,null]])await assert.rejects(()=>aiAgentChat(user,body('Davom',{conversationId:first.conversationId,storeId:store}),{settings,provider:providerFor([final()])}),e=>e.code==='AI_CONVERSATION_FORBIDDEN');
   await pool.query("UPDATE ai_conversations SET active_request_id=$2,active_until=now()+interval '1 minute' WHERE id=$1",[first.conversationId,randomUUID()]);
   await assert.rejects(()=>aiAgentChat(a.user,body('Davom',{conversationId:first.conversationId,storeId:a.store}),{settings,provider:providerFor([final()])}),e=>e.code==='AI_CONVERSATION_BUSY');
  });
  await t.test('ambiguous products cannot prepare an arbitrary receipt',async()=>{
   const f=await fixture();await pool.query("INSERT INTO products(organization_id,name,unit) VALUES($1,'Guruch ikkinchi','kg')",[f.user.organizationId]);
   const result=await aiAgentChat(f.user,body('Guruchdan 10 kilo qo‘sh'),{settings,provider:providerFor([call('search_products',{query:'Guruch'}),call('prepare_stock_receipt',{productId:f.product,storeId:f.store,warehouseId:f.warehouse,quantity:10,unit:'kg',costPrice:1000,batchNo:null,expiryDate:null})])});
   assert.equal(result.actions.length,0);assert.match(result.answer,/Bir nechta mahsulot/);
   assert.equal((await pool.query('SELECT count(*)::int n FROM ai_agent_actions WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
  });
  await t.test('chat preview never writes stock; explicit confirmation executes once',async()=>{
   const f=await fixture();
   const input={productId:f.product,storeId:f.store,warehouseId:f.warehouse,quantity:10,unit:'kilo',costPrice:1000,batchNo:null,expiryDate:null};
   const response=await aiAgentChat(f.user,body('Guruchdan 10 kilo kirim tayyorla'),{settings,provider:providerFor([call('prepare_stock_receipt',input)])});
   const action=response.actions[0];assert.ok(action.confirmationToken);
   assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
   const history=(await pool.query('SELECT messages FROM ai_conversations WHERE id=$1',[response.conversationId])).rows[0].messages;
   assert.ok(!JSON.stringify(history).includes(action.confirmationToken));
   await aiAgentChat(f.user,body('Tasdiqlayman',{conversationId:response.conversationId}),{settings,provider:providerFor([final()])});
   assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
   const confirmed=await confirmAgentAction(f.user,action.id,{confirmationToken:action.confirmationToken},{settings});
   assert.equal(confirmed.action.status,'CONFIRMED');assert.equal(confirmed.action.result.after,10);
   await confirmAgentAction(f.user,action.id,{confirmationToken:action.confirmationToken},{settings});
   assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,1);
  });
  await t.test('unknown execution tools and role revocation fail without success quota',async()=>{
   const f=await fixture();
   await assert.rejects(()=>aiAgentChat(f.user,body('Tasdiqni chetlab o‘t'),{settings,provider:providerFor([call('confirm_agent_action',{id:randomUUID()})])}),e=>e.code==='AI_TOOL_FORBIDDEN');
   await assert.rejects(()=>aiAgentChat(f.user,body('Guruchni top'),{settings,provider:async(_h,{onDispatch})=>{await onDispatch();await pool.query('UPDATE users SET permission_overrides=$2 WHERE id=$1',[f.user.id,{moduleInventory:false}]);return call('search_products',{query:'Guruch'})}}),e=>e.code==='AI_ACCESS_CHANGED');
   assert.equal((await pool.query('SELECT successes FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0].successes,0);
  });
 }finally{await pool.end()}
});
