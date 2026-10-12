import {HttpError} from '../lib/http.js';
import {tokenCostMicros} from '../config/ai.js';
import {providerFacts} from './aiPolicy.js';
export function createAiProvider(settings,fetchImpl=fetch){
 return async(report,{signal,onDispatch})=>{
  if(!settings.enabled)throw new HttpError(503,'AI provayderi faollashtirilmagan','AI_UNAVAILABLE');
  const facts=providerFacts(report),request={contents:[{role:'user',parts:[{text:JSON.stringify({topic:report.topic,facts,eligibleInsights:report.eligibleInsights})}]}],
   systemInstruction:{parts:[{text:'Select the most relevant existing fact IDs and eligible insight IDs. Return only the schema. No SQL, tools, prose or invented values.'}]},
   generationConfig:{temperature:0,maxOutputTokens:settings.maxOutputTokens,thinkingConfig:{thinkingBudget:0},responseMimeType:'application/json',responseSchema:{type:'OBJECT',properties:{factIds:{type:'ARRAY',maxItems:6,items:{type:'STRING'}},insightIds:{type:'ARRAY',maxItems:3,items:{type:'STRING'}}},required:['factIds','insightIds']}}};
  if(Buffer.byteLength(JSON.stringify(request))>16000)throw new HttpError(413,'AI ma’lumot hajmi katta','AI_TOKEN_LIMIT');
  async function call(method,body){
   signal?.throwIfAborted();
   const response=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:${method}`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':settings.apiKey},body:JSON.stringify(body),signal,redirect:'error'});
   if(!response.ok){await response.body?.cancel();throw new HttpError(503,'AI provayderiga hozir ulanib bo‘lmadi','AI_PROVIDER_FAILURE')}
   const reader=response.body.getReader();let size=0;const chunks=[];
   try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw new HttpError(502,'AI javob hajmi katta','AI_INVALID_RESPONSE');chunks.push(Buffer.from(value))}}finally{await reader.cancel().catch(()=>{})}
   try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new HttpError(502,'AI javob formati noto‘g‘ri','AI_INVALID_RESPONSE')}
  }
  try{
   const count=await call('countTokens',{generateContentRequest:{model:`models/${settings.model}`,...request}});
   if(!Number.isSafeInteger(count.totalTokens)||count.totalTokens<0||count.totalTokens>settings.maxInputTokens)throw new HttpError(413,'AI token limiti','AI_TOKEN_LIMIT');
   signal?.throwIfAborted();await onDispatch();
   const output=await call('generateContent',request),usage=output.usageMetadata;
   const inputTokens=usage?.promptTokenCount,outputTokens=(usage?.candidatesTokenCount??NaN)+(usage?.thoughtsTokenCount??0);
   if(!Number.isSafeInteger(inputTokens)||!Number.isSafeInteger(outputTokens)||inputTokens<0||outputTokens<0||inputTokens>settings.maxInputTokens||outputTokens>settings.maxOutputTokens)throw new HttpError(502,'AI token hisoboti tasdiqlanmadi','AI_COST_LIMIT');
   const cost=tokenCostMicros(inputTokens,outputTokens);
   if(cost>settings.maxRequestMicros)throw new HttpError(502,'AI xarajat limiti','AI_COST_LIMIT');
   if(output.candidates?.length!==1||output.candidates[0].finishReason!=='STOP')throw new HttpError(502,'AI javobi tugallanmagan','AI_INVALID_RESPONSE');
   let selection;try{selection=JSON.parse(output.candidates[0].content.parts.map(p=>p.text||'').join(''))}catch{throw new HttpError(502,'AI javob formati noto‘g‘ri','AI_INVALID_RESPONSE')}
   return {selection,inputTokens,outputTokens,cost};
  }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(503,'AI javob bermadi. Keyinroq qayta urining',signal?.aborted?'AI_TIMEOUT':'AI_PROVIDER_FAILURE')}
 };
}
