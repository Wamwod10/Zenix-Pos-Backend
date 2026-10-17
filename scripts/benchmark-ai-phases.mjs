// Synthetic provider + real disposable DB orchestration. No model key or external traffic.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL,target=assertSafeTestDatabaseUrl(url);assert.equal(url,process.env.DATABASE_URL);assert.equal(process.env.NODE_ENV,'test');assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55436');
process.env.ZENIX_PERFORMANCE_METRICS='true';
const [{pool},{aiAgentChat},{aiSettings,tokenCostMicros},{performanceMetrics}]=await Promise.all([import('../src/db/pool.js'),import('../src/services/aiAgentChat.js'),import('../src/config/ai.js'),import('../src/lib/performanceMetrics.js')]);
const rows=[];
try{
 const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Synthetic final AI phases','PREMIUM','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
 const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Synthetic') RETURNING id",[org])).rows[0].id;
 const id=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Synthetic',$3,'test-only','OWNER') RETURNING id",[org,store,randomUUID()])).rows[0].id;
 const session=(await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[id,randomUUID()])).rows[0].id;
 const user={id,organizationId:org,storeId:store,sessionId:session,appRole:'OWNER',permissionOverrides:{},rolePermissions:{}};
 const settings={...aiSettings(),enabled:true,writesEnabled:false,userPerMinute:1000,businessPerMinute:1000};
 for(const fallback of [false,true]){
  performanceMetrics.reset();
  const samples=[];let providerCalls=0,inputTokens=0,outputTokens=0,promptCharacters=0;
  for(let i=0;i<(fallback?10:30);i++){
   let step=0;
   const provider=async(history,{onDispatch,evidence})=>{
    await onDispatch();await new Promise(resolve=>setTimeout(resolve,10));
    providerCalls++;inputTokens+=100;outputTokens+=20;promptCharacters+=JSON.stringify(history).length;
    const usage={inputTokens:100,outputTokens:20,cost:tokenCostMicros(100,20)};
    if(step++===0){const callId=randomUUID(),name='get_business_overview',args={storeId:store};return {...usage,reply:null,calls:[{callId,name,args}],items:[{type:'function_call',call_id:callId,name,arguments:JSON.stringify(args),status:'completed'}]};}
    return {...usage,calls:[],items:[],reply:fallback?{kind:'results',reply:'Savdo 999999999 so‘m.'}:{kind:'results',reply:'Tekshirilgan natija.',blocks:[{type:'facts',text:'Hisobot',factIds:[evidence[0].id]}]}};
   };
   const start=performance.now();const response=await aiAgentChat(user,{requestId:randomUUID(),question:'Biznesimni tekshir',storeId:store},{settings,provider});
   assert.ok(response.answer);assert.equal(response.actions.length,0);samples.push(performance.now()-start);
  }
  const sorted=[...samples].sort((a,b)=>a-b);
  rows.push({scenario:fallback?'validated_fallback':'verified_report',n:samples.length,totalMs:{p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],p99:sorted.at(-1)},providerCalls,syntheticUsage:{inputTokens,outputTokens,promptCharacters},phases:performanceMetrics.snapshot(),samples});
 }
 const out=new URL('../../artifacts/performance-final-20261016/',import.meta.url);await mkdir(out,{recursive:true});
 await writeFile(new URL('ai-backend-phases.json',out),JSON.stringify({environment:'Synthetic fixed10ms provider; actual local PostgreSQL entitlement/quota/conversation/report/evidence/fallback pipeline. No OpenAI call, no production quota. Synthetic token usage is NOT model tokenizer measurement.',rows},null,2));console.log(JSON.stringify(rows.map(({samples,...r})=>r),null,2));
}finally{await pool.end();}
