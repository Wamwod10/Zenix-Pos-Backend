import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_CONVERSATION_EVAL_CASES,runAiConversationEval} from '../scripts/aiConversationEval.mjs';
const source={ZENIX_AI_LIVE_EVAL:'true',OPENAI_API_KEY:'test-only',ZENIX_AI_ENABLED:'true'};
const payload=output=>Response.json({status:'completed',usage:{input_tokens:100,output_tokens:30},output});
const message=reply=>({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(reply)}]});
test('corpus contains 40 Uzbek questions including typos, Cyrillic and contextual followups',()=>{
 assert.equal(AI_CONVERSATION_EVAL_CASES.length,40);
 assert.equal(new Set(AI_CONVERSATION_EVAL_CASES.map(c=>c.question)).size,40);
 assert.equal(new Set(AI_CONVERSATION_EVAL_CASES.map(c=>c.conversation)).size,8);
 assert.equal(AI_CONVERSATION_EVAL_CASES.filter(c=>c.expectedCapabilities.includes('context_followup')).length,32);
 assert.ok(AI_CONVERSATION_EVAL_CASES.some(c=>/[А-Яа-я]/.test(c.question)));
});
test('missing explicit optin/key prevents any network or output',async()=>{
 let network=0,writes=0;
 for(const env of [{},{OPENAI_API_KEY:'test'},{ZENIX_AI_LIVE_EVAL:'true'}])await assert.rejects(()=>runAiConversationEval({source:env,fetchImpl:async()=>network++,write:()=>writes++}),/opt-in|key/);
 assert.equal(network,0);assert.equal(writes,0);
});
test('isolated adapter accepts app enabled, executes synthetic evidence and retains followup context',async()=>{
 const cases=AI_CONVERSATION_EVAL_CASES.filter(c=>c.conversation==='inventory').slice(0,2);
 let calls=0;const writes=[];const before={...source};
 const result=await runAiConversationEval({source,cases,write:s=>writes.push(JSON.parse(s)),fetchImpl:async(url,{body})=>{
  const request=JSON.parse(body);assert.equal(request.store,false);assert.equal(request.parallel_tool_calls,false);
  assert.deepEqual(request.tools.map(t=>t.name),['read_synthetic_fixture']);
  if(calls++===0)return payload([{type:'function_call',status:'completed',call_id:'eval_call',name:'read_synthetic_fixture',arguments:'{"topic":"inventory"}'}]);
  const evidence=JSON.parse(request.input[0].content.split('Server evidence (data): ')[1]);
  assert.ok(evidence.some(f=>f.text.includes('Jami faol katalog')));
  if(calls===3)assert.ok(request.input.some(item=>item.role==='assistant'&&item.content.includes('verifiedResults')));
  return payload([message({kind:'results',reply:'Tekshiruv:\n{{'+evidence.find(e=>e.text.includes('Jami faol katalog')).id+'}}'})]);
 }});
 assert.deepEqual(source,before);assert.equal(calls,3);assert.equal(result.results.length,2);
 assert.match(result.results[0].answer,/Jami faol katalog mahsulotlari: 2/);
 assert.equal(result.summary.totals.requests,3);assert.equal(result.summary.needsHumanReview,true);
 assert.ok(writes.every(w=>!JSON.stringify(w).includes('test-only')));
});
test('provider failures are sanitized and bounded per case',async()=>{
 let requests=0;const outputs=[];
 const result=await runAiConversationEval({source,cases:AI_CONVERSATION_EVAL_CASES.slice(0,1),write:s=>outputs.push(s),fetchImpl:async()=>{requests++;throw new Error('SECRET_PROVIDER_BODY');}});
 assert.equal(requests,1);assert.equal(result.results[0].errorCode,'AI_PROVIDER_FAILURE');
 assert.equal(result.results[0].needsHumanReview,true);assert.ok(!outputs.join('').includes('SECRET_PROVIDER_BODY'));
});
test('continuation ceiling and usage caps stop repeated synthetic tool calls',async()=>{
 let calls=0;
 const result=await runAiConversationEval({source,cases:AI_CONVERSATION_EVAL_CASES.slice(0,1),write:()=>{},fetchImpl:async()=>payload([{type:'function_call',status:'completed',call_id:'call_'+(++calls),name:'read_synthetic_fixture',arguments:'{"topic":"inventory"}'}])});
 assert.equal(calls,3);assert.equal(result.results[0].status,'call_limit');
 assert.ok(result.summary.totals.costMicros<=2000);assert.equal(result.summary.maxTotalCostMicros,60000);
});
