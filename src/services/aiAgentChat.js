import {z} from 'zod';
import {sha256} from '../lib/crypto.js';
import {HttpError} from '../lib/http.js';
import {tokenCostMicros} from '../config/ai.js';
import {scopedStoreId} from '../lib/storeScope.js';
import {withTransaction} from '../db/tx.js';
import {recheckAgentActor} from './aiAgentActor.js';
import {authorizationKey} from './aiPolicy.js';
import {reserveAi,markAiDispatched,finishAi} from './aiQuota.js';
import {acquireConversation,releaseConversation} from './aiConversationStore.js';
import {toolsFor,executeAgentTool,modelToolResult} from './aiAgentRegistry.js';
import {assertAgentQuestion,renderAgentAnswer} from './aiAgentReply.js';

const schema=z.object({requestId:z.string().uuid(),question:z.string().trim().min(1).max(1000),storeId:z.string().uuid().nullable().optional(),conversationId:z.string().uuid().nullable().optional()}).strict();
const MAX_STEPS=5;
const recheckAiActor=(user,key)=>withTransaction(db=>recheckAgentActor(db,user,key));
export async function aiAgentChat(user,body,{settings,provider,toolRunner=executeAgentTool}){
 if(!settings.enabled)throw new HttpError(503,'AI faollashtirilmagan','AI_UNAVAILABLE');
 const input=schema.parse(body),question=assertAgentQuestion(input.question),storeId=scopedStoreId(user,input.storeId),key=authorizationKey(user);
 await recheckAiActor(user,key);
 const admission=await reserveAi(user,input.requestId,sha256(JSON.stringify([question,storeId,input.conversationId||null])),key,settings);
 if(admission.replay){await recheckAiActor(user,key);return admission.replay}
 const signal=AbortSignal.timeout(settings.timeoutMs);
 let conversation,settled=false,completedHistory;
 try{
  conversation=await acquireConversation(user,{conversationId:input.conversationId,storeId,key,requestId:input.requestId,timeoutMs:settings.timeoutMs});
  const history=[...conversation.messages,{role:'user',content:question}],toolResults=[],actions=[],ids=new Set();
  let dispatched=false,reply=null,complete=false,inputTokens=0,outputTokens=0,cost=0;
  for(let step=0;step<MAX_STEPS;step++){
   signal.throwIfAborted();await recheckAiActor(user,key);
   const result=await provider(history,{signal,tools:toolsFor(settings),budget:{inputTokens:settings.maxInputTokens-inputTokens,outputTokens:settings.maxOutputTokens-outputTokens,cost:settings.maxRequestMicros-cost},onDispatch:async()=>{if(!dispatched){await markAiDispatched(user,input.requestId);dispatched=true}}});
   signal.throwIfAborted();
   if(![result.inputTokens,result.outputTokens,result.cost].every(n=>Number.isSafeInteger(n)&&n>=0)||result.cost!==tokenCostMicros(result.inputTokens,result.outputTokens))throw new HttpError(502,'AI xarajat hisoboti noto‘g‘ri','AI_COST_LIMIT');
   inputTokens+=result.inputTokens;outputTokens+=result.outputTokens;cost+=result.cost;
   if(inputTokens>settings.maxInputTokens||outputTokens>settings.maxOutputTokens||cost>settings.maxRequestMicros)throw new HttpError(502,'AI xarajat limiti','AI_COST_LIMIT');
   if(!Array.isArray(result.calls)||result.calls.length>1)throw new HttpError(502,'AI vosita javobi noto‘g‘ri','AI_INVALID_RESPONSE');
   if(!result.calls.length){reply=result.reply;complete=true;break}
   const call=result.calls[0];
   if(ids.has(call.callId)||typeof call.callId!=='string'||!call.callId)throw new HttpError(502,'AI vosita takrorlangan','AI_INVALID_RESPONSE');ids.add(call.callId);
   await recheckAiActor(user,key);
   let output;
   const ambiguous=toolResults.some(t=>t.result.kind==='products'&&t.result.candidates.length>1);
   if(call.name==='prepare_stock_receipt'&&ambiguous)output={kind:'clarification',message:'Bir nechta mahsulot topildi. Avval aniq mahsulotni tanlang.'};
   else output=await toolRunner(user,call.name,call.args,{settings,requestId:input.requestId,conversationId:conversation.id,storeId});
   toolResults.push({name:call.name,result:output});
   if(output.kind==='action')actions.push(output.action);
   const safeOutput=modelToolResult(output);
   // Keep protocol call/output pairs only within this turn; history stores summaries.
   history.push(...result.items,{type:'function_call_output',call_id:call.callId,output:JSON.stringify(safeOutput)});
   if(output.kind==='action'||output.kind==='clarification'||output.kind==='products'&&output.candidates.length>1){complete=true;break}
  }
  if(!complete)throw new HttpError(502,'AI vosita bosqichlari cheklangan','AI_TOOL_LIMIT');
  await recheckAiActor(user,key);signal.throwIfAborted();
  const report=toolResults.findLast(t=>t.result.kind==='report')?.result.report||null;
  const response={requestId:input.requestId,conversationId:conversation.id,answer:renderAgentAnswer(reply,toolResults),report,insights:[],toolResults,actions,generatedAt:new Date().toISOString()};
  // Per-call rounding is conservative; accounting boundary uses the same whole-turn total.
  const totalCost=tokenCostMicros(inputTokens,outputTokens);
  if(totalCost>settings.maxRequestMicros)throw new HttpError(502,'AI xarajat limiti','AI_COST_LIMIT');
  settled=Boolean(await finishAi(user,input.requestId,{response,inputTokens,outputTokens,cost:totalCost}));
  if(!settled)throw new HttpError(409,'AI so‘rov muddati tugagan','AI_TIMEOUT');
  completedHistory=[...conversation.messages,{role:'user',content:question},{role:'assistant',content:JSON.stringify({answer:response.answer,verifiedResults:toolResults.map(t=>({name:t.name,result:modelToolResult(t.result)}))})}];
  return response;
 }catch(error){
  if(!settled)await finishAi(user,input.requestId,{errorCode:error instanceof HttpError?error.code:signal.aborted?'AI_TIMEOUT':'AI_FAILURE'});
  if(error instanceof HttpError)throw error;
  throw new HttpError(503,'AI vaqtincha javob bermadi',signal.aborted?'AI_TIMEOUT':'AI_FAILURE');
 }finally{
  if(conversation)await releaseConversation(user,conversation.id,input.requestId,completedHistory).catch(()=>{});
 }
}
