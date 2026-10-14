import {pool} from '../db/pool.js';
import {withTransaction} from '../db/tx.js';
import {HttpError} from '../lib/http.js';

export async function acquireConversation(user,{conversationId,storeId,key,requestId,timeoutMs}){
 return withTransaction(async db=>{
  let row;
  if(conversationId){
   row=(await db.query(`SELECT * FROM ai_conversations WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND session_id=$4
    AND store_id IS NOT DISTINCT FROM $5::uuid AND authorization_key=$6 AND expires_at>now() FOR UPDATE`,[conversationId,user.organizationId,user.id,user.sessionId,storeId,key])).rows[0];
   if(!row)throw new HttpError(403,'Suhbat sessiyasi yoki ruxsatlari o‘zgargan','AI_CONVERSATION_FORBIDDEN');
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
 const bounded=messages?.slice(-24);
 if(bounded&&Buffer.byteLength(JSON.stringify(bounded))>12000)bounded.splice(0,bounded.length);
 await pool.query(`UPDATE ai_conversations SET active_request_id=NULL,active_until=NULL,
  messages=COALESCE($5::jsonb,messages),expires_at=now()+interval '30 minutes'
  WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND session_id=$4 AND active_request_id=$6`,[id,user.organizationId,user.id,user.sessionId,bounded?JSON.stringify(bounded):null,requestId]);
}
