import {pool} from '../db/pool.js';
import {withTransaction} from '../db/tx.js';
import {HttpError} from '../lib/http.js';

export function boundConversationMessages(messages,maxBytes=12000){
 const bounded=Array.isArray(messages)?messages.slice(-24).map(m=>({...m})):[];
 while(bounded.length>2&&Buffer.byteLength(JSON.stringify(bounded))>maxBytes)bounded.splice(0,2);
 if(bounded.length&&Buffer.byteLength(JSON.stringify(bounded))>maxBytes){
  const last=bounded.at(-1);let summary;try{summary=JSON.parse(last.content)}catch{summary={answer:String(last.content||'')}}
  summary.answer=String(summary.answer||'').slice(0,2400);
  summary.verifiedResults=Array.isArray(summary.verifiedResults)?summary.verifiedResults:[];
  last.content=JSON.stringify(summary);
  while(summary.verifiedResults.length&&Buffer.byteLength(JSON.stringify(bounded))>maxBytes){summary.verifiedResults.shift();last.content=JSON.stringify(summary)}
  // UTF-8 and JSON escaping can exceed a character budget. Keep the trusted
  // identity memory and latest question; shorten only assistant prose further.
  while(summary.answer.length&&Buffer.byteLength(JSON.stringify(bounded))>maxBytes){summary.answer=Array.from(summary.answer).slice(0,Math.floor(Array.from(summary.answer).length*0.8)).join('');last.content=JSON.stringify(summary)}
 }
 return bounded;
}

export async function acquireConversation(user,{conversationId,storeId,key,requestId,timeoutMs}){
 return withTransaction(async db=>{
  let row;
  if(conversationId){
   row=(await db.query(`SELECT * FROM ai_conversations WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND session_id=$4
    AND store_id IS NOT DISTINCT FROM $5::uuid AND authorization_key=$6 FOR UPDATE`,[conversationId,user.organizationId,user.id,user.sessionId,storeId,key])).rows[0];
   if(!row)throw new HttpError(403,'Suhbat sessiyasi yoki ruxsatlari o‘zgargan','AI_CONVERSATION_FORBIDDEN');
   if(new Date(row.expires_at)<=new Date())throw new HttpError(410,'Suhbat muddati tugagan. Yangi suhbat boshlang.','AI_CONVERSATION_EXPIRED');
   if(row.active_until&&new Date(row.active_until)>new Date())throw new HttpError(409,'Suhbatda oldingi so‘rov bajarilmoqda','AI_CONVERSATION_BUSY');
  }else{
   row=(await db.query(`INSERT INTO ai_conversations(organization_id,user_id,session_id,store_id,authorization_key) VALUES($1,$2,$3,$4,$5) RETURNING *`,[user.organizationId,user.id,user.sessionId,storeId,key])).rows[0];
  }
  await db.query(`UPDATE ai_conversations SET active_request_id=$2,active_until=now()+$3*interval '1 millisecond' WHERE id=$1`,[row.id,requestId,timeoutMs+5000]);
  return {id:row.id,messages:Array.isArray(row.messages)?row.messages:[]};
 });
}
export async function releaseConversation(user,id,requestId,messages){
 // Bounded completed turns only; transient/failed tool results are not retained.
 const bounded=messages?boundConversationMessages(messages):undefined;
 await pool.query(`UPDATE ai_conversations SET active_request_id=NULL,active_until=NULL,
  messages=COALESCE($5::jsonb,messages),expires_at=now()+interval '30 minutes'
  WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND session_id=$4 AND active_request_id=$6`,[id,user.organizationId,user.id,user.sessionId,bounded?JSON.stringify(bounded):null,requestId]);
}
