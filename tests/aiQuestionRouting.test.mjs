import test from 'node:test';
import assert from 'node:assert/strict';
import {simpleReportTopic,simpleLatestSaleQuestion,isSaleAssessmentQuestion,isTodaySalesExistenceQuestion} from '../src/services/aiQuestionRouting.js';
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

test('Cyrillic and apostrophe variants route to the same verified narrow read',()=>{
 for(const q of ['Бугун қанча савдо бўлди?','Бугун нечта чек урилди?','Bugun qancha savdo bo\u0027ldi?','Bugun qancha savdo bo‘ldi?'])
  assert.equal(simpleReportTopic(q),'today_sales',q);
 assert.equal(simpleReportTopic('Мижозлар қарзи жами қанча?'),'customer_debt');
 assert.equal(simpleReportTopic('Таъминотчиларга қанча қарзимиз бор?'),'supplier_debt');
 assert.equal(simpleReportTopic('Кеча қанча савдо бўлди?'),null);
 assert.equal(simpleReportTopic('Нега бугун савдо ошди?'),null);
});
test('elliptical followups require verified same-day server memory, not guessed context',()=>{
 const memory={storeId:null,product:null,warehouse:null,period:{topic:'today_sales',from:'2026-11-02',to:'2026-11-02'}};
 const same={memory,businessDate:'2026-11-02'};
 for(const q of ['Yalpisi-chi?','Qaytarishlar-chi?','Sof savdo-chi?','Нечта чек-чи?'])
  assert.equal(simpleReportTopic(q,same),'today_sales',q);
 for(const q of ['Yalpisi-chi?','Qaytarishlar-chi?']){
  assert.equal(simpleReportTopic(q,{memory,businessDate:'2026-11-03'}),null);
  assert.equal(simpleReportTopic(q,{businessDate:'2026-11-02'}),null);
  assert.equal(simpleReportTopic(q,{memory:{...memory,period:{...memory.period,topic:'expenses'}},businessDate:'2026-11-02'}),null);
 }
 for(const q of ['Nega ko‘paydi?','Batafsil ayt','Qaytarish qabul qil','Qaytarishlarni taqqosla'])
  assert.equal(simpleReportTopic(q,same),null);
});

test('yes-no today-sales questions require a fresh scoped report in Latin and Cyrillic',()=>{
 for(const q of ['Bugun savdo bo‘ldimi?','Bugun savdo boldimi?','Бугун савдо бўлдими?',
  'Bugun savdo bormi?','Bugun nechta savdo bo‘ldi?']){
  if(q.includes('nechta'))assert.equal(isTodaySalesExistenceQuestion(q),false);
  else assert.equal(isTodaySalesExistenceQuestion(q),true,q);
  assert.equal(simpleReportTopic(q),'today_sales',q);
 }
 for(const q of ['Kecha savdo bo‘ldimi?','Bugun savdo bo‘ldimi, nega?',
  'Bugun savdo bo‘ldimi, kecha bilan solishtir','Bugun savdo bo‘ldimi, foyda qancha?',
  'Bugun xarajat bo‘ldimi?','Bugun savdoni bekor qil']){
  assert.equal(isTodaySalesExistenceQuestion(q),false,q);
  assert.notEqual(simpleReportTopic(q),'today_sales',q);
 }
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
  assert.deepEqual(q.tools[0].parameters.properties.topic.enum,['today_sales']);
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

test('a model cannot substitute an unrelated report topic for a forced read',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const tool={type:'function',name:'get_business_report',strict:true,description:'Read report',
  parameters:{type:'object',properties:{topic:{type:'string',enum:['today_sales','expenses','customer_debt']},storeId:{type:['string','null']}},required:['topic','storeId'],additionalProperties:false}};
 const original=JSON.stringify(tool);
 const provider=createAiAgentProvider(settings,async(_url,{body})=>{
  const q=JSON.parse(body);
  assert.deepEqual(q.tools[0].parameters.properties.topic.enum,['today_sales']);
  return response([{type:'function_call',status:'completed',call_id:'wrong_topic',
   name:'get_business_report',arguments:JSON.stringify({topic:'expenses',storeId:null})}]);
 });
 await assert.rejects(()=>provider([{role:'user',content:'Bugun qancha savdo qildim?'}],
  {tools:[tool],onDispatch:async()=>{}}),error=>error.code==='AI_INVALID_RESPONSE'&&error.details?.reason==='wrong_report_topic');
 assert.equal(JSON.stringify(tool),original,'shared registry schema must not be mutated');
});

test('verified memory allows forced fresh read for short same-day followup',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const memory={storeId:null,product:null,warehouse:null,period:{topic:'today_sales',from:'2026-11-02',to:'2026-11-02'}};
 const report={type:'function',name:'get_business_report',strict:true,description:'Read report',
  parameters:{type:'object',properties:{topic:{type:'string',enum:['today_sales','expenses']},storeId:{type:['string','null']}},required:['topic','storeId'],additionalProperties:false}};
 const provider=createAiAgentProvider(settings,async(_url,{body})=>{
  const request=JSON.parse(body);
  assert.equal(request.tool_choice,'required');
  assert.deepEqual(request.tools[0].parameters.properties.topic.enum,['today_sales']);
  return response([{type:'function_call',status:'completed',call_id:'followup_1',name:'get_business_report',arguments:'{"topic":"today_sales","storeId":null}'}]);
 });
 const answer=await provider([{role:'user',content:'Qaytarishlar-chi?'}],{tools:[report],memory,businessDate:'2026-11-02',onDispatch:async()=>{}});
 assert.equal(answer.calls[0].args.topic,'today_sales');
});

test('simple latest-sale intent is narrow and never routes history or writes',()=>{
 for(const q of ['Oxirgi marta nima sotilgan?','Oxirgi savdoda nimalar sotilgan?','So‘nggi chekda qancha sotilgan?','Охирги марта нима сотилган?'])
  assert.equal(simpleLatestSaleQuestion(q),true,q);
 for(const q of ['Oxirgi 7 kunda nima sotilgan?','Oxirgi oyda sotuvlar qanday?',
  'Oxirgi savdoni bekor qil','Oxirgi savdoda qaytarish qancha?',
  'Oxirgi savdoni kechagi bilan solishtir','Omborda oxirgi qoldiq qancha?'])
  assert.equal(simpleLatestSaleQuestion(q),false,q);
});

test('business growth request starts with only the permitted overview tool',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const read={type:'function',name:'get_business_overview',strict:true,description:'Read overview',
  parameters:{type:'object',properties:{storeId:{type:['string','null']}},required:['storeId'],additionalProperties:false}};
 const write={type:'function',name:'prepare_stock_receipt',strict:true,description:'Prepare write',
  parameters:{type:'object',properties:{},required:[],additionalProperties:false}};
 let n=0;
 const provider=createAiAgentProvider(settings,async(_url,{body})=>{
  n++;const q=JSON.parse(body);
  assert.equal(q.tool_choice,'required');
  assert.deepEqual(q.tools.map(x=>x.name),['get_business_overview']);
  assert.match(q.input[0].content,/business growth|business improvement/i);
  return response([{type:'function_call',status:'completed',call_id:'overview_1',name:'get_business_overview',
   arguments:JSON.stringify({storeId:null})}]);
 });
 const result=await provider([{role:'user',content:'Nimalar qilsam biznesim rivojlanadi?'}],
  {tools:[read,write],onDispatch:async()=>{}});
 assert.equal(n,1);
 assert.equal(result.calls[0].name,'get_business_overview');
});
test('latest-sale provider uses a single read-only tool and a small first request',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const read={type:'function',name:'get_latest_sale',strict:true,description:'Read last sale',
  parameters:{type:'object',properties:{storeId:{type:['string','null']},saleId:{type:['string','null']}},required:['storeId','saleId'],additionalProperties:false}};
 const write={type:'function',name:'prepare_stock_receipt',strict:true,description:'Write inventory',
  parameters:{type:'object',properties:{},required:[],additionalProperties:false}};
 let calls=0;
 const provider=createAiAgentProvider(settings,async(_url,{body})=>{
  calls++;
  const request=JSON.parse(body);
  assert.ok(Buffer.byteLength(body)+256<settings.maxInputTokens);
  assert.equal(request.tool_choice,'required');
  assert.deepEqual(request.tools.map(t=>t.name),['get_latest_sale']);
  assert.match(request.input[0].content,/saleId null/);
  return response([{type:'function_call',status:'completed',call_id:'latest_only',
   name:'get_latest_sale',arguments:JSON.stringify({storeId:null,saleId:null})}]);
 });
 const result=await provider([{role:'user',content:'Oxirgi marta nima sotilgan?'}],
  {tools:[read,write],onDispatch:async()=>{}});
 assert.equal(calls,1);
 assert.deepEqual(result.calls.map(x=>x.name),['get_latest_sale']);
});

test('latest-sale tool cannot be redirected to a different sale id',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const read={type:'function',name:'get_latest_sale',strict:true,description:'Read last sale',
  parameters:{type:'object',properties:{storeId:{type:['string','null']},saleId:{type:['string','null']}},required:['storeId','saleId'],additionalProperties:false}};
 const provider=createAiAgentProvider(settings,async()=>response([{type:'function_call',status:'completed',call_id:'other_sale',
  name:'get_latest_sale',arguments:JSON.stringify({storeId:null,saleId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})}]));
 await assert.rejects(
  provider([{role:'user',content:'Oxirgi marta nima sotilgan?'}],{tools:[read],onDispatch:async()=>{}}),
  error=>error.code==='AI_INVALID_RESPONSE'&&error.details?.reason==='wrong_latest_sale_id');
});

test('evaluative sales questions differ from receipt listing and writes',()=>{
 for(const q of ['Bu savdo yaxshi hisoblanadimi?','Shu chek foydalimi?','Ushbu sotuv yomonmi?',
  'Oxirgi savdoni baholab ber','Бу савдо яхши ҳисобланадими?'])
  assert.equal(isSaleAssessmentQuestion(q),true,q);
 for(const q of ['Oxirgi savdoda nima sotilgan?','Bugungi barcha savdolar yaxshimi?',
  'Nega bu savdo yaxshi?','Bu savdoni bekor qil','Oxirgi savdoni boshqa sana bilan solishtir'])
  assert.equal(isSaleAssessmentQuestion(q),false,q);
});

test('follow-up sale assessment forces exact verified receipt and branch, never latest unrelated sale',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const saleId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const storeId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const memory={storeId:null,sale:{id:saleId,storeId,saleNumber:'SALE-15',businessDate:'2026-10-29'},product:null,warehouse:null,period:null};
 const read={type:'function',name:'get_latest_sale',strict:true,description:'Read permitted sale',
  parameters:{type:'object',properties:{storeId:{type:['string','null'],format:'uuid'},saleId:{type:['string','null'],format:'uuid'}},required:['storeId','saleId'],additionalProperties:false}};
 const write={type:'function',name:'prepare_stock_receipt',strict:true,description:'Prepare write',
  parameters:{type:'object',properties:{},required:[],additionalProperties:false}};
 let called=0;
 const provider=createAiAgentProvider(settings,async(_url,{body})=>{
  const payload=JSON.parse(body);called++;
  assert.equal(payload.tool_choice,'required');
  assert.deepEqual(payload.tools.map(t=>t.name),['get_latest_sale']);
  assert.deepEqual(payload.tools[0].parameters.properties.saleId.enum,[saleId]);
  assert.deepEqual(payload.tools[0].parameters.properties.storeId.enum,[storeId]);
  assert.match(payload.input[0].content,/Do not repeat product rows/);
  return response([{type:'function_call',status:'completed',call_id:'same_sale',
   name:'get_latest_sale',arguments:JSON.stringify({saleId,storeId})}]);
 });
 const result=await provider([{role:'user',content:'Bu savdo yaxshi hisoblanadimi?'}],
  {memory,tools:[read,write],onDispatch:async()=>{}});
 assert.equal(called,1);
 assert.deepEqual(result.calls.map(c=>c.args),[{saleId,storeId}]);
});

test('model cannot redirect evaluative question to a different sale ID',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 const storeId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const saleId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const memory={storeId:null,sale:{id:saleId,storeId,saleNumber:'SALE-15',businessDate:'2026-10-29'}};
 const read={type:'function',name:'get_latest_sale',strict:true,description:'Read permitted sale',
  parameters:{type:'object',properties:{storeId:{type:['string','null'],format:'uuid'},saleId:{type:['string','null'],format:'uuid'}},required:['storeId','saleId'],additionalProperties:false}};
 const provider=createAiAgentProvider(settings,async()=>response([{type:'function_call',status:'completed',call_id:'wrong_sale',
  name:'get_latest_sale',arguments:JSON.stringify({saleId:null,storeId})}]));
 await assert.rejects(()=>provider([{role:'user',content:'Bu savdo yaxshi hisoblanadimi?'}],
  {memory,tools:[read],onDispatch:async()=>{}}),e=>e.code==='AI_INVALID_RESPONSE'&&e.details?.reason==='wrong_assessment_sale_id');
});
