import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {aiSettings} from '../src/config/ai.js';
import {createAiAgentProvider} from '../src/services/aiAgentProvider.js';

// No database, registry, application enablement or production data is used here.
const tools=[{type:'function',name:'get_test_quantity',description:'Return a fixed synthetic test quantity; contains no business data.',strict:true,
  parameters:{type:'object',properties:{},required:[],additionalProperties:false}}];

export async function runAiAgentLiveSmoke({source=process.env,fetchImpl=fetch,write=console.log}={}){
  if(source.ZENIX_AI_LIVE_SMOKE!=='true')throw new Error('Live smoke requires explicit opt-in');
  if(!source.OPENAI_API_KEY?.trim())throw new Error('Live smoke requires a server API key');
  if(source.ZENIX_AI_ENABLED==='true')throw new Error('Application AI must remain disabled during smoke');
  // This local adapter override permits only the synthetic tool below. It never
  // changes process.env, application approvals, write access or deployment settings.
  const settings={...aiSettings({OPENAI_API_KEY:source.OPENAI_API_KEY,ZENIX_AI_MODEL:source.ZENIX_AI_MODEL}),enabled:true,writesEnabled:false};
  const provider=createAiAgentProvider(settings,fetchImpl);
  const history=[{role:'user',content:'This is a synthetic connectivity test with no business data. First call get_test_quantity with empty arguments. Do not answer before receiving its tool output. After receiving that output, return kind results with a short Uzbek acknowledgement containing no numbers.'}];
  const signal=AbortSignal.timeout(settings.timeoutMs);
  let inputTokens=0,outputTokens=0,cost=0;
  const turn=async()=>{
    const result=await provider(history,{signal,tools,budget:{inputTokens:settings.maxInputTokens-inputTokens,outputTokens:settings.maxOutputTokens-outputTokens,cost:settings.maxRequestMicros-cost},onDispatch:async()=>{}});
    assert.ok([result.inputTokens,result.outputTokens,result.cost].every(value=>Number.isSafeInteger(value)&&value>=0));
    inputTokens+=result.inputTokens;outputTokens+=result.outputTokens;cost+=result.cost;
    assert.ok(inputTokens<=settings.maxInputTokens&&outputTokens<=settings.maxOutputTokens&&cost<=settings.maxRequestMicros);
    return result;
  };
  const first=await turn();
  assert.equal(first.calls.length,1);assert.equal(first.reply,null);
  assert.equal(first.calls[0].name,'get_test_quantity');assert.deepEqual(first.calls[0].args,{});
  history.push(...first.items,{type:'function_call_output',call_id:first.calls[0].callId,output:JSON.stringify({synthetic:true,quantity:'7',unit:'test_units'})});
  const final=await turn();
  assert.equal(final.calls.length,0);assert.equal(final.reply?.kind,'results');
  // Never print model output, tool contents, prompts, secrets or provider errors.
  write(JSON.stringify({inputTokens,outputTokens,costMicros:cost}));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  runAiAgentLiveSmoke().catch(()=>{console.error('AI synthetic live smoke failed');process.exitCode=1});
}
