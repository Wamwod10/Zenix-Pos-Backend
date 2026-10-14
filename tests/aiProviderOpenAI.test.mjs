import test from 'node:test';
import assert from 'node:assert/strict';
import {aiSettings,AI_MODEL,AI_RATES,tokenCostMicros} from '../src/config/ai.js';
import {createAiProvider} from '../src/services/aiProvider.js';

const enabledEnv={NODE_ENV:'production',OPENAI_API_KEY:'test-not-real',ZENIX_AI_ENABLED:'true',ZENIX_AI_PROVIDER_APPROVED:'true',ZENIX_AI_DATA_PROCESSING_APPROVED:'true',ZENIX_AI_PAID_PROJECT_CONFIRMED:'true',ZENIX_AI_PRODUCTION_APPROVED:'true'};
const report={topic:'today_sales',facts:[{id:'sales',label:'Savdo',value:42,unit:'count'},{id:'absent',label:'Missing',value:null}],eligibleInsights:['CHECK_WEEKLY']};
function mockedResponse(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})}
const successful={status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({factIds:['sales'],insightIds:['CHECK_WEEKLY']})}]}]};

test('OpenAI production activation is fail-closed',()=>{
  assert.equal(aiSettings(enabledEnv).enabled,true);
  assert.equal(aiSettings({...enabledEnv,OPENAI_API_KEY:''}).enabled,false);
  assert.equal(aiSettings({...enabledEnv,ZENIX_AI_DATA_PROCESSING_APPROVED:'false'}).enabled,false);
  assert.equal(aiSettings({...enabledEnv,ZENIX_AI_PRODUCTION_APPROVED:'false'}).enabled,false);
  assert.equal(aiSettings({...enabledEnv,ZENIX_AI_ENABLED:'false'}).enabled,false);
  assert.equal(aiSettings({...enabledEnv,OPENAI_API_KEY:'',ZENIX_AI_API_KEY:'old-google-key'}).enabled,false);
});
test('Luna accounting uses currently published uncached token rates',()=>{
  assert.equal(AI_MODEL,'gpt-6-luna');assert.equal(AI_RATES.inputMicrosPerMillion,100000);assert.equal(AI_RATES.outputMicrosPerMillion,500000);
  assert.equal(tokenCostMicros(100,50),35);
  assert.ok(tokenCostMicros(8000,1200)<=aiSettings(enabledEnv).maxRequestMicros);
});
test('OpenAI Responses request stores no data, uses schema, and limits fact exposure',async()=>{
  let dispatched=0, calls=0;
  const fake=async(url,opts)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(opts.headers.Authorization,'Bearer test-not-real');
    assert.equal(dispatched,1);
    const req=JSON.parse(opts.body);
    assert.equal(req.model,'gpt-6-luna');assert.equal(req.store,false);
    assert.equal(req.reasoning.effort,'none');assert.equal(req.text.format.strict,true);
    assert.equal(req.text.format.schema.additionalProperties,false);
    const facts=JSON.parse(req.input[1].content).facts;
    assert.deepEqual(facts,[{id:'sales',value:42,unit:'count'}]);
    return mockedResponse(successful)
  };
  const result=await createAiProvider(aiSettings(enabledEnv),fake)(report,{onDispatch:()=>{dispatched++}});
  assert.deepEqual(result.selection,{factIds:['sales'],insightIds:['CHECK_WEEKLY']});
  assert.equal(result.cost,35);assert.equal(calls,1);
});
test('OpenAI provider rejects errors without leaking response details',async()=>{
  const fn=createAiProvider(aiSettings(enabledEnv),async()=>mockedResponse({error:{message:'DO_NOT_EXPOSE'}},401));
  await assert.rejects(fn(report,{onDispatch:async()=>{}}),e=>e.code==='AI_PROVIDER_FAILURE'&&!e.message.includes('DO_NOT_EXPOSE'));
});
test('OpenAI invalid usage is rejected',async()=>{
  const fn=createAiProvider(aiSettings(enabledEnv),async()=>mockedResponse({...successful,usage:{input_tokens:99999,output_tokens:50}}));
  await assert.rejects(fn(report,{onDispatch:async()=>{}}),e=>e.code==='AI_COST_LIMIT');
});
test('Disabled provider never calls an upstream service',async()=>{
  const fn=createAiProvider(aiSettings({...enabledEnv,ZENIX_AI_ENABLED:'false'}),async()=>{throw Error('must not call')});
  await assert.rejects(fn(report,{onDispatch:async()=>{}}),e=>e.code==='AI_UNAVAILABLE');
});

for(const [name,body] of [
  ['refusal',{...successful,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'private'}]}]}],
  ['incomplete',{...successful,status:'incomplete'}],
  ['malformed JSON',{...successful,output:[{...successful.output[0],content:[{type:'output_text',text:'not JSON'}]}]}],
  ['oversized response',{...successful,padding:'x'.repeat(65536)}],
  ['invalid content shape',{...successful,output:[{...successful.output[0],content:{text:'wrong'}}]}],
])test('OpenAI rejects '+name,async()=>{
  const fn=createAiProvider(aiSettings(enabledEnv),async()=>mockedResponse(body));
  await assert.rejects(fn(report,{onDispatch:async()=>{}}),e=>e.code==='AI_INVALID_RESPONSE');
});
test('abort during quota dispatch prevents upstream call',async()=>{
  const controller=new AbortController();let calls=0;
  const fn=createAiProvider(aiSettings(enabledEnv),async()=>{calls++;return mockedResponse(successful)});
  await assert.rejects(fn(report,{signal:controller.signal,onDispatch:async()=>controller.abort()}),e=>e.code==='AI_TIMEOUT');
  assert.equal(calls,0);
});
