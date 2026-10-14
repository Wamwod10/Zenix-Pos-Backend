import test from 'node:test';
import assert from 'node:assert/strict';
import {aiSettings} from '../src/config/ai.js';
import * as transport from '../src/services/aiProvider.js';
import * as agentModule from '../src/services/aiAgentProvider.js';
const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
const tools=[{type:'function',name:'get_sales',description:'Read sales',strict:true,parameters:{type:'object',properties:{},required:[],additionalProperties:false}}];
const history=[{role:'user',content:'Savdo haqida ayting'}];
const call={type:'function_call',id:'fc_a',call_id:'call_a',name:'get_sales',arguments:'{}',status:'completed'};
const message=(reply={kind:'greeting',reply:'Assalomu alaykum!'})=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(reply)}]});
const payload=output=>({status:'completed',usage:{input_tokens:100,output_tokens:20},output});
const provider=(output,fetcher)=>agentModule.createAiAgentProvider(settings,fetcher|| (async()=>Response.json(payload(output))));
const options={tools,onDispatch:async()=>{}};

test('model configuration rejects unpriced models and keeps writes disabled',()=>{
 assert.equal(aiSettings({}).model,'gpt-6-luna');
 assert.equal(aiSettings({ZENIX_AI_MODEL:'gpt-6-luna'}).model,'gpt-6-luna');
 assert.equal(aiSettings({}).writesEnabled,false);
 assert.throws(()=>aiSettings({ZENIX_AI_MODEL:'unpriced-model'}),/ZENIX_AI_MODEL/);
});
test('agent sends strict Responses tools and returns a single parsed call',async()=>{
 let dispatched=0;
 const p=provider([call],async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test-only');
  const body=JSON.parse(options.body);
  assert.equal(body.store,false);assert.equal(body.parallel_tool_calls,false);assert.equal(body.tool_choice,'auto');
  assert.equal(body.reasoning.effort,'none');assert.equal(body.tools[0].strict,true);
  assert.equal(body.input[0].role,'developer');assert.deepEqual(body.input.slice(1),history);
  assert.equal(body.text.format.strict,true);assert.deepEqual(body.text.format.schema.required,['kind','reply']);
  return Response.json(payload([call]));
 });
 assert.equal(p.agent,true);
 const result=await p(history,{...options,onDispatch:async()=>dispatched++});
 assert.equal(dispatched,1);assert.deepEqual(result.calls,[{callId:'call_a',name:'get_sales',args:{}}]);
 assert.equal(result.reply,null);assert.deepEqual(result.items,[call]);assert.equal(result.cost,20);
});
test('agent returns a schema-validated final reply',async()=>{
 const result=await provider([message()])(history,options);
 assert.deepEqual(result.calls,[]);assert.deepEqual(result.reply,{kind:'greeting',reply:'Assalomu alaykum!'});
});
test('agent rejects call ids already present in the conversation',async()=>{
 await assert.rejects(()=>provider([call])([...history,call,{type:'function_call_output',call_id:'call_a',output:'{}'}],options),e=>e.status===502&&e.code==='AI_INVALID_RESPONSE');
});
test('agent drops only oldest complete conversation turns to fit the remaining input budget',async()=>{
 const oldTurns=Array.from({length:3},(_,i)=>[{role:'user',content:`old user ${i} ${'x'.repeat(1200)}`},{role:'assistant',content:`old reply ${i} ${'y'.repeat(1200)}`}]).flat();
 const recent=[...history,{...call,call_id:'previous_current_call'},{type:'function_call_output',call_id:'previous_current_call',output:'{"synthetic":true}'}];
 const input=[...oldTurns,...recent];let dispatched=0;
 const p=agentModule.createAiAgentProvider(settings,async(url,{body})=>{
  const sent=JSON.parse(body).input;
  assert.deepEqual(sent.slice(1),[...oldTurns.slice(4),...recent]);
  assert.ok(Buffer.byteLength(body)+256<=6000);
  return Response.json(payload([message()]));
 });
 await p(input,{...options,budget:{inputTokens:6000,outputTokens:1200,cost:2000},onDispatch:async()=>dispatched++});
 assert.equal(dispatched,1);assert.equal(input.length,9);
});
test('agent preserves an oversized current turn and fails without dispatch',async()=>{
 let dispatched=0,network=0;
 const p=agentModule.createAiAgentProvider(settings,async()=>{network++;return Response.json(payload([message()]))});
 await assert.rejects(()=>p([{role:'user',content:'x'.repeat(7000)},call,{type:'function_call_output',call_id:call.call_id,output:'{}'}],{...options,onDispatch:async()=>dispatched++}),e=>e.status===413&&e.code==='AI_TOKEN_LIMIT');
 assert.equal(dispatched,0);assert.equal(network,0);
});
for(const [name,output] of [
 ['mixed calls and messages',[call,message()]],['multiple calls',[call,{...call,call_id:'call_b'}]],
 ['unknown tool',[{...call,name:'confirm_action'}]],['empty call id',[{...call,call_id:' '}]],
 ['duplicate call id',[call,{...call}]],['unfinished call',[{...call,status:'in_progress'}]],
 ['non-object arguments',[{...call,arguments:'[]'}]],['invalid argument JSON',[{...call,arguments:'{'}]],
 ['empty output',[]],['unknown output',[{type:'reasoning'}]],
 ['refusal',[{...message(),content:[{type:'refusal',refusal:'No'}]}]],
 ['unfinished message',[{...message(),status:'in_progress'}]],
 ['multiple text blocks',[{...message(),content:[...message().content,...message().content]}]],
 ['invalid final kind',[message({kind:'invented',reply:'Salom'})]],
 ['extra final property',[message({kind:'greeting',reply:'Salom',facts:[]})]],
 ['numeric final reply',[message({kind:'results',reply:'Savdo １２ dona'})]],
 ['oversized final reply',[message({kind:'advice',reply:'a'.repeat(651)})]],
 ['empty final reply',[message({kind:'advice',reply:' '})]],
])test(`agent rejects ${name}`,async()=>{
 await assert.rejects(()=>provider(output)(history,options),e=>e.status===502&&e.code==='AI_INVALID_RESPONSE');
});
test('transport caps output reservation and rejects exhausted budgets before dispatch',async()=>{
 let dispatched=0,network=0;
 const request={model:settings.model,input:history,max_output_tokens:1200,store:false};
 const opts={onDispatch:async()=>dispatched++,fetchImpl:async(url,{body})=>{
  network++;assert.equal(JSON.parse(body).max_output_tokens,40);return Response.json(payload([message()]));
 },budget:{inputTokens:8000,outputTokens:40,cost:2000}};
 await transport.requestOpenAiResponse(settings,request,opts);
 assert.equal(dispatched,1);assert.equal(network,1);
 for(const budget of [{inputTokens:1,outputTokens:1200,cost:2000},{inputTokens:8000,outputTokens:0,cost:2000},{inputTokens:8000,outputTokens:1200,cost:1}]){
  await assert.rejects(()=>transport.requestOpenAiResponse(settings,request,{...opts,budget}),e=>e.status===413);
 }
 assert.equal(dispatched,1);assert.equal(network,1);
});
test('transport never dispatches oversized UTF-8 inputs or sends after dispatch abort',async()=>{
 let dispatched=0,network=0;const controller=new AbortController();
 const opts={signal:controller.signal,onDispatch:async()=>{dispatched++;controller.abort()},fetchImpl:async()=>{network++;return Response.json(payload([message()]))}};
 const request={model:settings.model,input:history,max_output_tokens:1200};
 await assert.rejects(()=>transport.requestOpenAiResponse(settings,{...request,input:[{role:'user',content:'é'.repeat(4000)}]},opts),e=>e.code==='AI_TOKEN_LIMIT');
 assert.equal(dispatched,0);
 await assert.rejects(()=>transport.requestOpenAiResponse(settings,request,opts),e=>e.code==='AI_TIMEOUT');
 assert.equal(dispatched,1);assert.equal(network,0);
});
test('transport refuses malformed and excessive usage, excessive response streams and sanitized failures',async()=>{
 const request={model:settings.model,input:history,max_output_tokens:40};
 for(const usage of [undefined,{input_tokens:1.5,output_tokens:20},{input_tokens:100,output_tokens:41}]){
  await assert.rejects(()=>transport.requestOpenAiResponse(settings,request,{onDispatch:async()=>{},fetchImpl:async()=>Response.json({...payload([message()]),usage})}),e=>e.status===502&&e.code==='AI_COST_LIMIT');
 }
 await assert.rejects(()=>provider([message()],async()=>new Response(' '.repeat(65537)))(history,options),e=>e.status===502);
 await assert.rejects(()=>provider([],async()=>{throw new Error('secret key and private error')})(history,options),e=>e.code==='AI_PROVIDER_FAILURE'&&!e.message.includes('secret'));
 let network=0;
 await assert.rejects(()=>agentModule.createAiAgentProvider({...settings,enabled:false},async()=>network++)(history,options),e=>e.code==='AI_UNAVAILABLE');
 assert.equal(network,0);
});
test('real read and prepare tool registries fit initial request and three-call continuation',async()=>{
 const previousNodeEnv=process.env.NODE_ENV;
 process.env.NODE_ENV='test';
 const {toolsFor}=await import('../src/services/aiAgentRegistry.js').finally(()=>{
  if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv;
 });
 for(const writesEnabled of [false,true]){
  const actualTools=toolsFor({...settings,writesEnabled}),items=[...history],sizes=[];
  let turns=0,inputTokens=0,outputTokens=0,cost=0;
  const p=agentModule.createAiAgentProvider(settings,async(url,{body})=>{
   sizes.push(Buffer.byteLength(body)+256);
   const output=turns++<3?[{...call,call_id:`call_${turns}`,name:'search_products',arguments:'{"query":"Synthetic product"}'}]:[message({kind:'results',reply:'Tekshiruv yakunlandi.'})];
   return Response.json({...payload(output),usage:{input_tokens:1000,output_tokens:20}});
  });
  for(let step=0;step<4;step++){
   const result=await p(items,{...options,tools:actualTools,budget:{inputTokens:settings.maxInputTokens-inputTokens,outputTokens:settings.maxOutputTokens-outputTokens,cost:settings.maxRequestMicros-cost}});
   inputTokens+=result.inputTokens;outputTokens+=result.outputTokens;cost+=result.cost;
   if(step<3){
    assert.equal(result.calls[0].name,'search_products');
    items.push(...result.items,{type:'function_call_output',call_id:result.calls[0].callId,output:JSON.stringify({kind:'products',candidates:[{productId:'00000000-0000-4000-8000-000000000001',name:'Synthetic product',sku:'SYNTHETIC',barcode:'SYNTHETIC',unit:'kg'}],hasMore:false})});
   }else assert.equal(result.reply.kind,'results');
  }
  assert.equal(turns,4);assert.equal(sizes.length,4);
  assert.ok(sizes.every((size,index)=>size<=settings.maxInputTokens-index*1000));
 }
});
test('live synthetic smoke refuses missing explicit opt-in or key before network',async()=>{
 const {runAiAgentLiveSmoke}=await import('../scripts/aiAgentLiveSmoke.mjs');
 let calls=0;const fetchImpl=async()=>{calls++;throw new Error('Unexpected network')};
 for(const source of [{OPENAI_API_KEY:'test-only'},{ZENIX_AI_LIVE_SMOKE:'true'},{ZENIX_AI_LIVE_SMOKE:'true',OPENAI_API_KEY:'test-only',ZENIX_AI_ENABLED:'true'}]){
  await assert.rejects(()=>runAiAgentLiveSmoke({source,fetchImpl}),/smoke|disabled|key/i);
 }
 assert.equal(calls,0);
});
test('live synthetic smoke uses two bounded calls and emits only usage totals',async()=>{
 const {runAiAgentLiveSmoke}=await import('../scripts/aiAgentLiveSmoke.mjs');
 const source={ZENIX_AI_LIVE_SMOKE:'true',OPENAI_API_KEY:'test-only',ZENIX_AI_ENABLED:'false'};
 let calls=0;const writes=[];
 await runAiAgentLiveSmoke({source,write:value=>writes.push(JSON.parse(value)),fetchImpl:async(url,{body})=>{
  const request=JSON.parse(body);assert.deepEqual(request.tools.map(t=>t.name),['get_test_quantity']);
  assert.equal(request.store,false);assert.equal(request.parallel_tool_calls,false);
  if(calls++){
   assert.equal(request.input.at(-1).type,'function_call_output');
   assert.equal(request.input.at(-1).call_id,'synthetic_call');
   return Response.json(payload([message({kind:'results',reply:'Sintetik tekshiruv yakunlandi.'})]));
  }
  return Response.json(payload([{...call,call_id:'synthetic_call',name:'get_test_quantity'}]));
 }});
 assert.equal(calls,2);assert.deepEqual(writes,[{inputTokens:200,outputTokens:40,costMicros:40}]);assert.equal(source.ZENIX_AI_ENABLED,'false');
});
