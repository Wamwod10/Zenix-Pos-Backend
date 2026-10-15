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
  await t.test('typed memory carries verified identities without replaying receipt quantities',async()=>{
   const f=await fixture(),first=await aiAgentChat(f.user,body('Guruch qoldig‘ini tekshir',{storeId:f.store}),{settings,provider:providerFor([call('search_products',{query:'Guruch'}),call('get_product_stock',{productId:f.product,storeId:f.store,warehouseId:f.warehouse}),final()])});
   const second=await aiAgentChat(f.user,body('Undan kirim tayyorla',{storeId:f.store,conversationId:first.conversationId}),{settings,provider:async(_h,{onDispatch,memory})=>{await onDispatch();assert.equal(memory.product.id,f.product);assert.equal(memory.warehouse.id,f.warehouse);assert.equal(memory.product.unit,'kg');assert.ok(!JSON.stringify(memory).includes('costPrice'));return call('prepare_stock_receipt',{productId:memory.product.id,warehouseId:memory.warehouse.id,storeId:f.store,quantity:null,unit:memory.product.unit,costPrice:null,batchNo:null,expiryDate:null})}});
   assert.equal(second.actions.length,0);assert.match(second.answer,/miqdor/);assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[f.user.organizationId])).rows[0].n,0);
   const messages=(await pool.query('SELECT messages FROM ai_conversations WHERE id=$1',[first.conversationId])).rows[0].messages;assert.equal(JSON.parse(messages.at(-1).content).memory.product.id,f.product);
  });
  await t.test('structured blocks materialize server facts and preserve the legacy summary',async()=>{
   const f=await fixture();let step=0;
   const response=await aiAgentChat(f.user,body('Bugungi savdoni tushuntir'),{settings,provider:async(_h,{onDispatch,evidence})=>{await onDispatch();if(step++===0)return call('get_business_report',{topic:'today_sales',storeId:null});return {...final(),reply:{kind:'results',reply:'Tekshirilgan natijani ko‘rib chiqamiz.',blocks:[{type:'facts',text:'Tasdiqlangan ko‘rsatkich',factIds:[evidence[0].id]},{type:'recommendation',text:'Xarajatlarni toifalab kuzating.',factIds:[]}]}}},toolRunner:async()=>({kind:'report',report:{facts:[{label:'Sof savdo',value:'12345.67',unit:'UZS'}],tables:[],notes:[]}})});
   assert.equal(response.answer,'Tekshirilgan natijani ko‘rib chiqamiz.');assert.match(response.blocks[0].facts[0].text,/12345.67/);
   await aiAgentChat(f.user,body('Tavsiyangizni tushuntiring',{conversationId:response.conversationId}),{settings,provider:async(history,{onDispatch})=>{await onDispatch();assert.ok(history.some(message=>message.role==='assistant'&&message.content.includes('Xarajatlarni toifalab kuzating.')));return final()}});
  });
  await t.test('repeated read calls reuse current-turn data; a new turn rereads fresh data',async()=>{
   const f=await fixture();let reads=0,step=0;
   const runner=async()=>{reads++;return {kind:'report',report:{topic:'today_sales',facts:[{label:'Sof savdo',value:'100',unit:'UZS'}],tables:[],notes:[]}}};
   const response=await aiAgentChat(f.user,body('Bugungi savdo'),{settings,toolRunner:runner,provider:async(_h,{onDispatch})=>{await onDispatch();return step++<2?call('get_business_report',{topic:'today_sales',storeId:null}):final()}});
   assert.equal(reads,1);
   await aiAgentChat(f.user,body('Qayta tekshir',{conversationId:response.conversationId}),{settings,toolRunner:runner,provider:providerFor([call('get_business_report',{topic:'today_sales',storeId:null}),final()])});assert.equal(reads,2);
  });
  await t.test('time reserve disables further exploration but preserves grounded followup',async()=>{
   const f=await fixture();let elapsed=0,step=0;
   await aiAgentChat(f.user,body('Biznesimni tahlil qil'),{settings,clock:()=>elapsed,provider:async(_h,{onDispatch,tools,evidence})=>{await onDispatch();if(step++===0){elapsed=settings.timeoutMs-5000;return call('get_business_report',{topic:'today_sales',storeId:null})}assert.deepEqual(tools,[]);return {...final(),reply:{kind:'results',reply:`Tekshirilgan natija: {{${evidence[0].id}}}`}}},toolRunner:async()=>({kind:'report',report:{facts:[{label:'Sof savdo',value:'100',unit:'UZS'}],tables:[],notes:[]}})});
   assert.equal(step,2);
  });
  await t.test('very little time returns current facts without another dispatch or success quota',async()=>{
   const f=await fixture();let elapsed=0,dispatches=0;
   const response=await aiAgentChat(f.user,body('Biznesimni tahlil qil'),{settings,clock:()=>elapsed,provider:async(_h,{onDispatch})=>{await onDispatch();dispatches++;return call('get_business_report',{topic:'today_sales',storeId:null})},toolRunner:async()=>{elapsed=settings.timeoutMs-1000;return {kind:'report',report:{facts:[{label:'Sof savdo',value:'123',unit:'UZS'}],tables:[],notes:[]}}}});
   assert.equal(dispatches,1);assert.equal(response.answerSource,'verified_fallback');assert.match(response.answer,/123/);
   const usage=(await pool.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0];assert.equal(usage.successes,0);assert.equal(Number(usage.input_tokens),100);
  });
  await t.test('cached reads cannot bypass live permission revocation',async()=>{
   const f=await fixture();let reads=0,step=0;
   await assert.rejects(()=>aiAgentChat(f.user,body('Savdoni tekshir'),{settings,provider:async(_h,{onDispatch})=>{await onDispatch();if(step++===1)await pool.query("UPDATE users SET app_role='SALES' WHERE id=$1",[f.user.id]);return call('get_business_report',{topic:'today_sales',storeId:null})},toolRunner:async()=>{reads++;return {kind:'report',report:{facts:[],tables:[],notes:[]}}}}),e=>e.code==='AI_ACCESS_CHANGED');assert.equal(reads,1);
  });
  await t.test('numeric output is repaired once with no tools and all calls billed once',async()=>{
   const f=await fixture();let attempts=0;
   const response=await aiAgentChat(f.user,body('Bugungi savdo natijalarini tahlil qil'),{settings,provider:async(_h,{onDispatch,tools,evidence})=>{
    await onDispatch();attempts++;
    if(attempts===1)return call('get_business_report',{topic:'today_sales',storeId:null});
    if(attempts===2)throw Object.assign(new (await import('../src/lib/http.js')).HttpError(502,'invalid','AI_EVIDENCE_INVALID',{stage:'evidence',reason:'unsupported_numeric_claim'}),{aiUsage:{inputTokens:100,outputTokens:20,cost:tokenCostMicros(100,20)}});
    assert.deepEqual(tools,[]);return {...final(),reply:{kind:'results',reply:`Bugungi tekshirilgan natija:\n{{${evidence[0].id}}}`}};
   },toolRunner:async()=>({kind:'report',report:{facts:[{label:'Sof savdo',value:'125000',unit:'UZS'}],tables:[],notes:[]}})});
   assert.equal(attempts,3);assert.match(response.answer,/125000/);
   const usage=(await pool.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0];
   assert.equal(usage.successes,1);assert.equal(Number(usage.input_tokens),300);assert.equal(Number(usage.spent_micros),tokenCostMicros(300,60));
  });
  await t.test('repeated numeric errors return safe clarification without successful quota or duplicate calls',async()=>{
   const f=await fixture();let attempts=0;
   const response=await aiAgentChat(f.user,body('Salom'),{settings,provider:async(_h,{onDispatch})=>{await onDispatch();attempts++;throw Object.assign(new (await import('../src/lib/http.js')).HttpError(502,'invalid','AI_EVIDENCE_INVALID',{stage:'evidence',reason:'unsupported_numeric_claim'}),{aiUsage:{inputTokens:100,outputTokens:20,cost:tokenCostMicros(100,20)}})}});
   assert.equal(attempts,2);assert.equal(response.answerSource,'clarification_fallback');assert.ok(!response.answer.includes('999'));
   const usage=(await pool.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0];assert.equal(usage.successes,0);assert.equal(Number(usage.input_tokens),200);assert.equal(Number(usage.spent_micros),tokenCostMicros(200,40));
  });
  await t.test('expired context is distinct from forbidden context and tool timeouts settle known spend',async()=>{
   const f=await fixture(),first=await aiAgentChat(f.user,body('Salom'),{settings,provider:providerFor([final()])});
   await pool.query("UPDATE ai_conversations SET expires_at=now()-interval '1 second' WHERE id=$1",[first.conversationId]);
   await assert.rejects(()=>aiAgentChat(f.user,body('Davom',{conversationId:first.conversationId}),{settings,provider:providerFor([final()])}),e=>e.code==='AI_CONVERSATION_EXPIRED');
   await assert.rejects(()=>aiAgentChat(f.user,body('Qoldiq'),{settings:{...settings,timeoutMs:250},provider:providerFor([call('get_business_report',{topic:'low_stock',storeId:null})]),toolRunner:()=>new Promise(resolve=>setTimeout(()=>resolve({kind:'report'}),350))}),e=>e.code==='AI_TOOL_TIMEOUT');
   const row=(await pool.query('SELECT successes,reserved,input_tokens,spent_micros FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0];
   assert.equal(row.successes,1);assert.equal(row.reserved,0);assert.equal(Number(row.input_tokens),200);
  });
  await t.test('repair budget exhaustion serves only current verified facts and replay never dispatches again',async()=>{
   const f=await fixture();let attempts=0;const input=body('Bugungi savdo');
   const provider=async(_h,{onDispatch})=>{await onDispatch();attempts++;if(attempts===1)return call('get_business_report',{topic:'today_sales',storeId:null});throw Object.assign(new (await import('../src/lib/http.js')).HttpError(502,'invalid','AI_EVIDENCE_INVALID',{stage:'evidence',reason:'unsupported_numeric_claim'}),{aiUsage:{inputTokens:100,outputTokens:200,cost:tokenCostMicros(100,200)}})};
   const result=await aiAgentChat(f.user,input,{settings:{...settings,maxOutputTokens:256},provider,toolRunner:async()=>({kind:'report',report:{topic:'business_overview',from:'2026-10-09',to:'2026-10-15',facts:[{id:'today_sales_today_net',label:'Sof savdo',value:'125000',unit:'UZS',from:'2026-10-15',to:'2026-10-15'}],tables:[],notes:[]}})});
   assert.equal(attempts,2);assert.equal(result.answerSource,'verified_fallback');assert.match(result.answer,/125 000 so‘m/);assert.ok(!result.answer.includes('Hisobot davri:'));
   const replay=await aiAgentChat(f.user,input,{settings,provider:async()=>{throw Error('must not redispatch')}});assert.deepEqual(replay,result);
   const usage=(await pool.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0];assert.equal(usage.successes,0);assert.equal(Number(usage.spent_micros),tokenCostMicros(200,220));
  });
  await t.test('repair does not mask provider, permission, cost or execution-claim failures',async()=>{
   const {HttpError}=await import('../src/lib/http.js');
   for(const [code,details] of [['AI_PROVIDER_FAILURE',{stage:'transport'}],['AI_COST_LIMIT',{stage:'usage'}],['AI_FORBIDDEN',{}],['AI_EVIDENCE_INVALID',{stage:'evidence',reason:'execution_claim'}]]){
    const f=await fixture();let attempts=0;
    await assert.rejects(()=>aiAgentChat(f.user,body('Salom'),{settings,provider:async(_h,{onDispatch})=>{attempts++;await onDispatch();throw Object.assign(new HttpError(502,'blocked',code,details),{aiUsage:{inputTokens:100,outputTokens:20,cost:tokenCostMicros(100,20)}})}}),e=>e.code===code);
    assert.equal(attempts,1);assert.equal((await pool.query('SELECT successes FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0].successes,0);
   }
  });
  await t.test('schema mismatch repairs once but a provider failure during repair remains visible with full known spend',async()=>{
   const {HttpError}=await import('../src/lib/http.js'),f=await fixture();let attempts=0;
   await assert.rejects(()=>aiAgentChat(f.user,body('Salom'),{settings,provider:async(_h,{onDispatch})=>{await onDispatch();attempts++;throw Object.assign(new HttpError(502,'blocked',attempts===1?'AI_INVALID_RESPONSE':'AI_PROVIDER_FAILURE',{stage:attempts===1?'parse':'transport',reason:'schema_mismatch'}),{aiUsage:{inputTokens:100,outputTokens:20,cost:tokenCostMicros(100,20)}})}}),e=>e.code==='AI_PROVIDER_FAILURE');
   assert.equal(attempts,2);const usage=(await pool.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0];assert.equal(usage.successes,0);assert.equal(Number(usage.spent_micros),tokenCostMicros(200,40));
  });
  await t.test('long conversation retains newest complete turns without mixing context',async()=>{
   const f=await fixture();let conversationId;
   for(let i=0;i<30;i++){
    const response=await aiAgentChat(f.user,body(`Biznes savoli ${i}`,{conversationId}),{settings:{...settings,userPerMinute:100,businessPerMinute:100},provider:async(h,{onDispatch})=>{await onDispatch();assert.ok(h.length<=25);return {...final(),reply:{kind:'advice',reply:'Hisobotlarni ko‘rib chiqib, keyingi savolni aniqlashtiramiz.'}}}});
    conversationId=response.conversationId;
   }
   const messages=(await pool.query('SELECT messages FROM ai_conversations WHERE id=$1',[conversationId])).rows[0].messages;
   assert.equal(messages.length,24);assert.equal(messages.at(-2).content,'Biznes savoli 29');
  });
  await t.test('failed billed schema response records actual usage without consuming successful quota',async()=>{
   const f=await fixture();let calls=0;
   const failure=Object.assign(new Error('private output must not leak'),{code:'AI_INVALID_RESPONSE',aiUsage:{inputTokens:200,outputTokens:20,cost:tokenCostMicros(200,20)}});
   await assert.rejects(()=>aiAgentChat(f.user,body('Hisobotni davom ettir'),{settings,provider:async(_h,{onDispatch})=>{await onDispatch();if(calls++===0)return call('get_business_report',{topic:'today_sales',storeId:null});throw failure},toolRunner:async()=>({kind:'report',report:{facts:[{id:'sales',label:'Savdo',value:'0',unit:'UZS'}],tables:[],notes:[]}})}));
   const usage=(await pool.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1',[f.user.organizationId])).rows[0];
   assert.equal(usage.successes,0);assert.equal(usage.reserved,0);assert.equal(Number(usage.input_tokens),300);assert.equal(Number(usage.output_tokens),40);assert.equal(Number(usage.spent_micros),tokenCostMicros(300,40));
  });
  await t.test('several tools produce a natural anchored reply and preserve evidence for follow-up',async()=>{
   const f=await fixture();let stage=0;
   const result=await aiAgentChat(f.user,body('Omborda ko‘p mahsulot bo‘lsa, nega kamayganlar nol?'),{settings,provider:async(_h,{onDispatch,evidence})=>{await onDispatch();if(stage++===0)return call('get_business_report',{topic:'low_stock',storeId:null});assert.ok(evidence.length);return {...final(),reply:{kind:'results',reply:`Jami mahsulotlar bilan minimal qoldiq boshqa ko‘rsatkichlar. {{${evidence[0].id}}}`}}},toolRunner:async()=>({kind:'report',report:{from:'2026-10-15',to:'2026-10-15',facts:[{id:'low_stock_count',label:'Minimal qoldiqdagi mahsulotlar',value:'0',unit:'count'}],tables:[],notes:[]}})});
   assert.match(result.answer,/boshqa ko‘rsatkichlar/);assert.match(result.answer,/0 ta/);
   await aiAgentChat(f.user,body('Nega?',{conversationId:result.conversationId}),{settings,provider:async(history,{onDispatch,evidence})=>{await onDispatch();assert.ok(history.some(m=>m.role==='assistant'));assert.ok(evidence.some(e=>e.text.includes('Minimal qoldiq')));return final()}});
  });
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
