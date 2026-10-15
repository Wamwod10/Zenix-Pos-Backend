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
import {recordAgentProgress} from './aiAgentProgress.js';
import {deriveAgentMemory} from './aiAgentMemory.js';
import {assertAgentQuestion,renderAgentAnswer,renderAgentBlocks,buildAgentEvidence,repairableAgentReply,safeAgentFallback} from './aiAgentReply.js';

const schema=z.object({requestId:z.string().uuid(),question:z.string().trim().min(1).max(1000),storeId:z.string().uuid().nullable().optional(),conversationId:z.string().uuid().nullable().optional()}).strict();
const MAX_STEPS=6;
const recheckAiActor=(user,key)=>withTransaction(db=>recheckAgentActor(db,user,key));
export async function aiAgentChat(user,body,{settings,provider,toolRunner=executeAgentTool,clock=Date.now}){
 if(!settings.enabled)throw new HttpError(503,'AI faollashtirilmagan','AI_UNAVAILABLE');
 const input=schema.parse(body),question=assertAgentQuestion(input.question),storeId=scopedStoreId(user,input.storeId),key=authorizationKey(user);
 await recheckAiActor(user,key);
 const admission=await reserveAi(user,input.requestId,sha256(JSON.stringify([question,storeId,input.conversationId||null])),key,settings);
 if(admission.replay){await recheckAiActor(user,key);return admission.replay}
 const progress=phase=>recordAgentProgress(user,input.requestId,phase);progress('understanding');
 const signal=AbortSignal.timeout(settings.timeoutMs);
 const deadline=clock()+settings.timeoutMs,finalReserve=Math.min(8000,Math.max(1000,Math.floor(settings.timeoutMs*0.4)));
 let conversation,settled=false,completedHistory,inputTokens=0,outputTokens=0,cost=0,providerPending=false,callDispatched=false,stage='conversation';
 const addUsage=usage=>{
  if(!usage||![usage.inputTokens,usage.outputTokens,usage.cost].every(n=>Number.isSafeInteger(n)&&n>=0)||usage.cost!==tokenCostMicros(usage.inputTokens,usage.outputTokens))return false;
  inputTokens+=usage.inputTokens;outputTokens+=usage.outputTokens;cost+=usage.cost;return true;
 };
 try{
  conversation=await acquireConversation(user,{conversationId:input.conversationId,storeId,key,requestId:input.requestId,timeoutMs:settings.timeoutMs});
  const history=[...conversation.messages,{role:'user',content:question}],toolResults=[],actions=[],ids=new Set(),readCache=new Map();
  const priorResults=conversation.messages.filter(m=>m.role==='assistant').flatMap(m=>{try{return JSON.parse(m.content).verifiedResults||[]}catch{return []}}).slice(-8);
  let dispatched=false,reply=null,complete=false,repaired=false,fallback=null,forceFinal=false;
  for(let step=0;step<MAX_STEPS;step++){
   signal.throwIfAborted();const current=await recheckAiActor(user,key);
   const remaining=deadline-clock(),finalizing=forceFinal||toolResults.length>0&&remaining<=finalReserve;
   if(toolResults.length&&remaining<=1500){fallback=safeAgentFallback(buildAgentEvidence(toolResults));fallback.answer='Yangi tekshiruv uchun vaqt yetarli emas. '+fallback.answer;complete=true;break}
   let result,repairing=false;
   for(;;){
    stage='provider';providerPending=true;callDispatched=false;progress('composing');
    try{
     result=await provider(history,{signal,businessDate:current.businessDate,memory:deriveAgentMemory(conversation.messages,toolResults,storeId),evidence:buildAgentEvidence([...toolResults,...priorResults]),tools:repairing||finalizing||step===MAX_STEPS-1?[]:toolsFor(settings),budget:{inputTokens:settings.maxInputTokens-inputTokens,outputTokens:settings.maxOutputTokens-outputTokens,cost:settings.maxRequestMicros-cost},onDispatch:async()=>{if(!dispatched){await markAiDispatched(user,input.requestId);dispatched=true}callDispatched=true}});
     if(!addUsage(result))throw new HttpError(502,'AI xarajat hisoboti noto‘g‘ri','AI_COST_LIMIT');
     providerPending=false;
     if((repairing||finalizing)&&result.calls?.length)throw new HttpError(403,'Yakuniy javobda tool chaqirish taqiqlangan','AI_TOOL_FORBIDDEN');
     if(result.reply){const evidence=buildAgentEvidence([...toolResults,...priorResults]);renderAgentAnswer(result.reply,toolResults,{evidence});renderAgentBlocks(result.reply,evidence)}
     break;
    }catch(error){
     const preflight=repairing&&!callDispatched&&error instanceof HttpError&&error.status===413&&['AI_TOKEN_LIMIT','AI_COST_LIMIT'].includes(error.code);
     if(!preflight&&!repairableAgentReply(error))throw error;
     if(providerPending&&!preflight&&!addUsage(error.aiUsage))throw error;
     providerPending=false;
     if(inputTokens>settings.maxInputTokens||outputTokens>settings.maxOutputTokens||cost>settings.maxRequestMicros)throw new HttpError(502,'AI xarajat limiti','AI_COST_LIMIT');
     signal.throwIfAborted();await recheckAiActor(user,key);
     if(preflight||repaired||settings.maxInputTokens-inputTokens<512||settings.maxOutputTokens-outputTokens<128||settings.maxRequestMicros-cost<tokenCostMicros(512,128)){
      fallback=safeAgentFallback(buildAgentEvidence(toolResults));result={calls:[],reply:null};break;
     }
     repaired=true;repairing=true;
     // No rejected output is echoed; a single final-answer repair cannot run tools.
     history.push({role:'developer',content:'The final answer failed validation. Return the reply JSON once more, with no tools. Use only server {{id}} anchors for every business quantity/date/name. Do not copy numbers into prose. Explain concepts without unsupported claims, or ask for clarification.'});
    }
   }
   signal.throwIfAborted();
   if(inputTokens>settings.maxInputTokens||outputTokens>settings.maxOutputTokens||cost>settings.maxRequestMicros)throw new HttpError(502,'AI xarajat limiti','AI_COST_LIMIT');
   if(!Array.isArray(result.calls)||result.calls.length>1)throw new HttpError(502,'AI vosita javobi noto‘g‘ri','AI_INVALID_RESPONSE');
   if(!result.calls.length){reply=result.reply;complete=true;break}
   const call=result.calls[0];
   if(ids.has(call.callId)||typeof call.callId!=='string'||!call.callId)throw new HttpError(502,'AI vosita takrorlangan','AI_INVALID_RESPONSE');ids.add(call.callId);
   await recheckAiActor(user,key);
   let output;stage='tool';progress(call.name==='prepare_stock_receipt'?'preparing_action':['search_products','list_locations','get_product_stock','get_warehouse_summary','get_restock_advice'].includes(call.name)?'reading_inventory':'reading_sales');
   const readOnly=toolsFor(settings).some(t=>t.name===call.name)&&!call.name.startsWith('prepare_');
   const cacheKey=readOnly?JSON.stringify([call.name,Object.entries(call.args||{}).sort(([a],[b])=>a.localeCompare(b))]):null;
   const ambiguous=toolResults.some(t=>t.result.kind==='products'&&t.result.candidates.length>1);
   if(call.name==='prepare_stock_receipt'&&ambiguous)output={kind:'clarification',message:'Bir nechta mahsulot topildi. Avval aniq mahsulotni tanlang.'};
   else if(cacheKey&&readCache.has(cacheKey)){output=readCache.get(cacheKey);forceFinal=true}
   else{
    let abortTool;
    try{output=await Promise.race([toolRunner(user,call.name,call.args,{settings,requestId:input.requestId,conversationId:conversation.id,storeId,signal}),new Promise((_,reject)=>{abortTool=()=>reject(new HttpError(504,'Biznes ma’lumotini olish vaqti tugadi.','AI_TOOL_TIMEOUT',{stage:'tool',reason:'timeout'}));signal.addEventListener('abort',abortTool,{once:true});if(signal.aborted)abortTool()})])}
    catch(error){if(error instanceof HttpError||error?.name==='ZodError')throw error;throw new HttpError(503,error?.code==='57014'?'Biznes tool vaqti tugadi. Qayta urinib ko‘ring.':'Biznes ma’lumotini olib bo‘lmadi. Qayta urinib ko‘ring.',error?.code==='57014'?'AI_TOOL_TIMEOUT':'AI_TOOL_FAILURE',{stage:'tool'})}
    finally{if(abortTool)signal.removeEventListener('abort',abortTool)}
    if(cacheKey)readCache.set(cacheKey,output);
   }
   toolResults.push({name:call.name,result:output});
   if(output.kind==='action')actions.push(output.action);
   const safeOutput=output.kind==='report'?{kind:'report',topic:output.report.topic,from:output.report.from,to:output.report.to,evidence:buildAgentEvidence([{name:call.name,result:output}])}:modelToolResult(output);
   // Keep protocol call/output pairs only within this turn; history stores summaries.
   history.push(...result.items,{type:'function_call_output',call_id:call.callId,output:JSON.stringify(safeOutput)});
   if(output.kind==='action'||output.kind==='clarification'||output.kind==='products'&&output.candidates.length>1){complete=true;break}
  }
  if(!complete)throw new HttpError(502,'AI vosita bosqichlari cheklangan','AI_TOOL_LIMIT');
  await recheckAiActor(user,key);signal.throwIfAborted();
  stage='evidence';progress('verifying');
  const report=toolResults.findLast(t=>t.result.kind==='report')?.result.report||null;
  const evidence=buildAgentEvidence([...toolResults,...priorResults]);
  const response={requestId:input.requestId,conversationId:conversation.id,...(fallback||{answer:renderAgentAnswer(reply,toolResults,{evidence})}),blocks:fallback?[]:renderAgentBlocks(reply,evidence),report,insights:[],toolResults,actions,generatedAt:new Date().toISOString()};
  // Per-call rounding is conservative; accounting boundary uses the same whole-turn total.
  const totalCost=tokenCostMicros(inputTokens,outputTokens);
  if(totalCost>settings.maxRequestMicros)throw new HttpError(502,'AI xarajat limiti','AI_COST_LIMIT');
  stage='settlement';settled=Boolean(await finishAi(user,input.requestId,{response,inputTokens,outputTokens,cost:totalCost,countSuccess:!fallback}));
  if(!settled)throw new HttpError(409,'AI so‘rov muddati tugagan','AI_TIMEOUT');
  const discussion=[response.answer,...response.blocks.filter(block=>block.type!=='facts').map(block=>block.text)].filter(Boolean).join('\n\n').slice(0,2400);
  completedHistory=[...conversation.messages,{role:'user',content:question},{role:'assistant',content:JSON.stringify({answer:discussion,memory:deriveAgentMemory(conversation.messages,toolResults,storeId),verifiedResults:toolResults.map(t=>({name:t.name,result:modelToolResult(t.result)}))})}];
  progress('complete');return response;
 }catch(error){
  progress('failed');
  const knownFailureUsage=providerPending&&addUsage(error.aiUsage);
  const usageUncertain=providerPending&&callDispatched&&!knownFailureUsage;
  if(!settled)await finishAi(user,input.requestId,{errorCode:error instanceof HttpError?error.code:signal.aborted?'AI_TIMEOUT':'AI_FAILURE',inputTokens,outputTokens,cost:usageUncertain?null:Math.min(settings.maxRequestMicros,tokenCostMicros(inputTokens,outputTokens))});
  if(error instanceof HttpError){error.details={...error.details,stage:error.details?.stage||stage};throw error}
  throw new HttpError(503,'AI vaqtincha javob bermadi',signal.aborted?'AI_TIMEOUT':'AI_FAILURE');
 }finally{
  if(conversation)await releaseConversation(user,conversation.id,input.requestId,completedHistory).catch(()=>{});
 }
}
