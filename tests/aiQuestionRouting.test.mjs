import test from 'node:test';
import assert from 'node:assert/strict';
import {simpleReportTopic} from '../src/services/aiQuestionRouting.js';
import {createAiAgentProvider} from '../src/services/aiAgentProvider.js';
import {aiSettings} from '../src/config/ai.js';

test('read routing recognizes short Uzbek metric questions, not broad or stale-period questions',()=>{
 for(const text of ['Bugun qancha savdo bo‘ldi?','Bugungi savdo qancha?','Bugun nechta chek urildi?','Bugun qaytarish jami qancha?'])
  assert.equal(simpleReportTopic(text),'today_sales',text);
 for(const [text,topic] of [['Mijozlar qarzi jami qancha?','customer_debt'],['Ta’minotchilarga qancha qarzimiz bor?','supplier_debt']])
  assert.equal(simpleReportTopic(text),topic,text);
 for(const text of ['Kecha qancha savdo bo‘ldi?','Nega bugun savdo ko‘paydi?','Bugun qancha foyda oldim?',
  'Bugun qancha mahsulot sotildi?','Bugun qancha xarajat bo‘ldi?','Bugungi savdoni batafsil tahlil qil',
  'Guruchdan qancha kirim qilamiz?','Mijoz qarzini to‘la','Bugungi va kechagi savdolarni solishtir',
  'Mijozlar va ta’minotchilar qarzi jami qancha?','Omborda qancha qoldiq bor?'])
  assert.equal(simpleReportTopic(text),null,text);
});

const response=output=>Response.json({status:'completed',usage:{input_tokens:80,output_tokens:30},output});
test('short first-turn sale question forces an authorized current read, never an action',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const tools=[
  {type:'function',name:'get_business_report',strict:true,description:'Read report',parameters:{type:'object',properties:{topic:{type:'string'},storeId:{type:['string','null']}},required:['topic','storeId'],additionalProperties:false}},
  {type:'function',name:'prepare_stock_receipt',strict:true,description:'Write preview',parameters:{type:'object',properties:{},required:[],additionalProperties:false}},
 ];
 let requests=0;
 const provider=createAiAgentProvider(settings,async(_url,{body})=>{
  const q=JSON.parse(body);requests++;
  assert.equal(q.tool_choice,'required');
  assert.deepEqual(q.tools.map(t=>t.name),['get_business_report']);
  assert.match(q.input[0].content,/unambiguous today_sales metric/);
  return response([{type:'function_call',status:'completed',call_id:'read_once',name:'get_business_report',
    arguments:JSON.stringify({topic:'today_sales',storeId:null})}]);
 });
 const result=await provider([{role:'user',content:'Bugun qancha savdo qildim?'}],{tools,onDispatch:async()=>{}});
 assert.equal(requests,1);assert.deepEqual(result.calls.map(c=>c.name),['get_business_report']);
});
test('follow-up with a current tool result can finish naturally, no forced extra lookup',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const tool={type:'function',name:'get_business_report',strict:true,description:'Read report',parameters:{type:'object',properties:{},required:[],additionalProperties:false}};
 const provider=createAiAgentProvider(settings,async(_url,{body})=>{
  const q=JSON.parse(body);assert.equal(q.tool_choice,'auto');
  return response([{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',
   text:JSON.stringify({kind:'results',reply:'{{f_verified}}',blocks:[]})}]}]);
 });
 const result=await provider([{role:'user',content:'Bugun qancha savdo?'},
  {type:'function_call',status:'completed',call_id:'first_read',name:'get_business_report',arguments:'{}'},
  {type:'function_call_output',call_id:'first_read',output:'{}'}],
 {tools:[tool],evidence:[{id:'f_verified',text:'Bugungi sof savdo: 10 000 so‘m'}],onDispatch:async()=>{}});
 assert.equal(result.reply.reply,'{{f_verified}}');
});
