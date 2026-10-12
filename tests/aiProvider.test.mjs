import test from 'node:test';
import assert from 'node:assert/strict';
import {aiSettings,tokenCostMicros} from '../src/config/ai.js';
import {createAiProvider} from '../src/services/aiProvider.js';
const settings={...aiSettings(),enabled:true,apiKey:'test-not-a-real-key'};
const report={topic:'today_sales',facts:[{id:'a',value:'123.40',unit:'UZS',label:'Secret user phone'}],eligibleInsights:['CHECK_WEEKLY']};
const payload={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({factIds:['a'],insightIds:[]})}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20}};
test('provider counts entire input, uses server key, strips names and validates bounded usage',async()=>{
 const calls=[];const provider=createAiProvider(settings,async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith(':countTokens')?{totalTokens:100}:payload)});
 let dispatched=0;const result=await provider(report,{signal:AbortSignal.timeout(5000),onDispatch:async()=>dispatched++});
 assert.equal(dispatched,1);assert.equal(result.cost,tokenCostMicros(100,20));assert.equal(calls.length,2);
 for(const c of calls){assert.equal(c.options.headers['x-goog-api-key'],settings.apiKey);assert.ok(!c.url.includes(settings.apiKey));assert.ok(!c.options.body.includes('Secret user phone'));assert.equal(c.options.redirect,'error')}
 assert.ok(JSON.parse(calls[0].options.body).generateContentRequest.systemInstruction);
});
for(const [name,response,code] of [['too many input tokens',{totalTokens:8001},'AI_TOKEN_LIMIT'],['missing usage',{...payload,usageMetadata:undefined},'AI_COST_LIMIT'],['too many output tokens',{...payload,usageMetadata:{promptTokenCount:1,candidatesTokenCount:1201}},'AI_COST_LIMIT'],['unfinished response',{...payload,candidates:[{finishReason:'MAX_TOKENS'}]},'AI_INVALID_RESPONSE']])test(name,async()=>{
 const provider=createAiProvider(settings,async url=>Response.json(url.endsWith(':countTokens')&&name!=='too many input tokens'?{totalTokens:100}:response));
 await assert.rejects(()=>provider(report,{onDispatch:async()=>{}}),e=>e.code===code);
});
test('provider failures sanitized, disabled adapter never calls network, aborted calls time out',async()=>{
 let calls=0;const fetcher=async()=>{calls++;throw new Error('private provider error and key')};
 await assert.rejects(()=>createAiProvider({...settings,enabled:false},fetcher)(report,{}),e=>e.code==='AI_UNAVAILABLE');assert.equal(calls,0);
 await assert.rejects(()=>createAiProvider(settings,fetcher)(report,{}),e=>e.code==='AI_PROVIDER_FAILURE'&&!e.message.includes('private'));
 await assert.rejects(()=>createAiProvider(settings,fetcher)(report,{signal:AbortSignal.abort()}),e=>e.code==='AI_TIMEOUT');
});
test('in-flight generation aborts at deadline',async()=>{
 const provider=createAiProvider(settings,async(url,{signal})=>{
  if(url.endsWith(':countTokens'))return Response.json({totalTokens:100});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('deadline ignored')),200);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)},{once:true})});
 });
 let dispatched=false;await assert.rejects(()=>provider(report,{signal:AbortSignal.timeout(20),onDispatch:async()=>{dispatched=true}}),e=>e.code==='AI_TIMEOUT');assert.equal(dispatched,true);
});
