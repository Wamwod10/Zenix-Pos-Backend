import {z} from 'zod';
import {pool} from '../db/pool.js';
import {sha256} from '../lib/crypto.js';
import {HttpError} from '../lib/http.js';
import {tokenCostMicros} from '../config/ai.js';
import {scopedStoreId} from '../lib/storeScope.js';
import {questionTopic,authorizeTopic,authorizationKey,validateSelection,AI_INSIGHTS} from './aiPolicy.js';
import {aiReport} from './aiReports.js';
import {reserveAi,markAiDispatched,finishAi} from './aiQuota.js';
import {aiAgentChat} from './aiAgentChat.js';
const inputSchema=z.object({requestId:z.string().uuid(),question:z.string().trim().min(1).max(1000),storeId:z.string().uuid().nullable().optional()}).strict();
export async function recheckAiActor(user,key){
 const row=(await pool.query(`SELECT u.app_role,u.store_id,u.permission_overrides,u.active,u.must_change_password,o.settings,subscription_can_write(o.id) writable
 FROM users u JOIN organizations o ON o.id=u.organization_id JOIN auth_sessions s ON s.user_id=u.id
 WHERE u.id=$1 AND u.organization_id=$2 AND s.id=$3 AND s.revoked_at IS NULL AND s.expires_at>now()`,[user.id,user.organizationId,user.sessionId])).rows[0];
 const current=row&&{...user,appRole:row.app_role,storeId:row.store_id,permissionOverrides:row.permission_overrides||{},rolePermissions:row.settings?.rolePermissions||{}};
 if(!row||!row.active||row.must_change_password||!row.writable||authorizationKey(current)!==key)throw new HttpError(403,'Sessiya yoki ma’lumot ruxsatlari o‘zgargan','AI_ACCESS_CHANGED');
}
export async function aiChat(user,body,{settings,provider}){
 if(provider.agent===true)return aiAgentChat(user,body,{settings,provider});
 const input=inputSchema.parse(body),topic=questionTopic(input.question);authorizeTopic(user,topic);
 const storeId=scopedStoreId(user,input.storeId),key=authorizationKey(user);
 await recheckAiActor(user,key);
 const admission=await reserveAi(user,input.requestId,sha256(JSON.stringify([input.question,storeId])),key,settings);
 if(admission.replay){await recheckAiActor(user,key);return admission.replay}
 const signal=AbortSignal.timeout(settings.timeoutMs);
 try{
  const report=await aiReport(user,topic,storeId);signal.throwIfAborted();await recheckAiActor(user,key);
  const result=await provider(report,{signal,onDispatch:()=>markAiDispatched(user,input.requestId)});
  signal.throwIfAborted();
  // Validate again at the application boundary, including injected test adapters.
  if(!Number.isSafeInteger(result.inputTokens)||!Number.isSafeInteger(result.outputTokens)||result.inputTokens<0||result.outputTokens<0||result.inputTokens>settings.maxInputTokens||result.outputTokens>settings.maxOutputTokens||result.cost!==tokenCostMicros(result.inputTokens,result.outputTokens)||result.cost>settings.maxRequestMicros)throw new HttpError(502,'AI xarajat hisoboti noto‘g‘ri','AI_COST_LIMIT');
  const selection=validateSelection(result.selection,report);await recheckAiActor(user,key);
  const selected=report.facts.filter(f=>selection.factIds.includes(f.id));
  const response={requestId:input.requestId,answer:selected.length?selected.map(f=>`${f.label}: ${f.value}${f.unit==='UZS'?' so‘m':f.unit==='count'?' ta':''}.`).join('\n'):'Tasdiqlangan ma’lumotlar quyida ko‘rsatilgan. Yetishmayotgan ma’lumotlar hisoblanmaydi.',report,insights:selection.insightIds.map(id=>AI_INSIGHTS[id]),generatedAt:new Date().toISOString()};
  const settled=await finishAi(user,input.requestId,{response,inputTokens:result.inputTokens,outputTokens:result.outputTokens,cost:result.cost});
  if(!settled)throw new HttpError(409,'AI so‘rov muddati tugagan','AI_TIMEOUT');
  return response;
 }catch(error){await finishAi(user,input.requestId,{errorCode:error instanceof HttpError?error.code:'AI_FAILURE'});if(error instanceof HttpError)throw error;throw new HttpError(503,'AI tahlili vaqtincha mavjud emas',signal.aborted?'AI_TIMEOUT':'AI_FAILURE')}
}
