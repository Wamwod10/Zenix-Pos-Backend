import {pool} from '../db/pool.js';
import {subscriptionPlan} from '../config/subscriptions.js';
import {tokenCostMicros} from '../config/ai.js';
import {HttpError} from '../lib/http.js';

async function transaction(work,{recovery=false}={}){const db=await pool.connect();try{await db.query('BEGIN');await db.query(recovery?"SET LOCAL lock_timeout='50ms'":"SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='3s'");const value=await work(db);await db.query('COMMIT');return value}catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}}
async function organization(db,id,skipLocked=false){return (await db.query(`SELECT o.*,subscription_effective_plan(id) code,subscription_can_write(id) writable,
 (statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date::text AS day,
 date_trunc('month',statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date::text period
 FROM organizations o WHERE id=$1 FOR UPDATE ${skipLocked?'SKIP LOCKED':''}`,[id])).rows[0]}
const planFor=org=>org?.plan_code?subscriptionPlan(org.code,org.pricing_version||1):null;
export async function aiStatus(user,settings){
 const org=(await pool.query(`SELECT o.*,subscription_effective_plan(id) code,subscription_can_write(id) writable,
 date_trunc('month',statement_timestamp() AT TIME ZONE 'Asia/Tashkent')::date::text period FROM organizations o WHERE id=$1`,[user.organizationId])).rows[0];
 if(!org)throw new HttpError(403,'Biznes topilmadi','AI_FORBIDDEN');
 const plan=planFor(org),limit=plan?.limits.aiRequests||0;
 const usage=(await pool.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1 AND period_start=$2',[org.id,org.period])).rows[0]||{};
 const [year,month]=org.period.split('-').map(Number),reset=new Date(Date.UTC(year,month,1)-5*3600000);
 return {planCode:plan?.code||null,limit,used:Number(usage.successes||0),reserved:Number(usage.reserved||0),remaining:Math.max(0,limit-Number(usage.successes||0)-Number(usage.reserved||0)),resetsAt:reset.toISOString(),writable:org.writable,enabled:settings.enabled,
  statistics:{inputTokens:Number(usage.input_tokens||0),outputTokens:Number(usage.output_tokens||0),spentMicros:Number(usage.spent_micros||0)}};
}
async function lockAccounting(db,row){
 await db.query('SELECT day FROM ai_daily_budget WHERE day=$1 FOR UPDATE',[row.day]);
 await db.query('SELECT organization_id FROM ai_monthly_usage WHERE organization_id=$1 AND period_start=$2 FOR UPDATE',[row.organization_id,row.period_start]);
}
async function settle(db,row,{response=null,errorCode=null,inputTokens=0,outputTokens=0,cost=null}={}){
 if(!['PENDING','DISPATCHED'].includes(row.status))return;
 const spent=cost??(row.status==='DISPATCHED'?Number(row.reserved_cost):0),success=Boolean(response);
 if(!Number.isSafeInteger(spent)||spent<0||spent>Number(row.reserved_cost))throw new Error('Invalid AI settlement');
 await db.query(`UPDATE ai_monthly_usage SET reserved=reserved-1,reserved_micros=reserved_micros-$3,successes=successes+$4,
 spent_micros=spent_micros+$5,input_tokens=input_tokens+$6,output_tokens=output_tokens+$7 WHERE organization_id=$1 AND period_start=$2`,[row.organization_id,row.period_start,row.reserved_cost,success?1:0,spent,inputTokens,outputTokens]);
 await db.query('UPDATE ai_daily_budget SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3 WHERE day=$1',[row.day,row.reserved_cost,spent]);
 await db.query(`UPDATE ai_requests SET status=$4,actual_cost=$5,response=$6,error_code=$7,response_expires_at=now()+interval '24 hours' WHERE organization_id=$1 AND user_id=$2 AND request_id=$3`,[row.organization_id,row.user_id,row.request_id,success?'SUCCEEDED':'FAILED',spent,response,errorCode]);
}
export async function recoverAiLeases(user){
 // Each lease uses the same lock order as admission/settlement; never hold two days.
 const expired=(await pool.query("SELECT organization_id,request_id,user_id FROM ai_requests WHERE status IN ('PENDING','DISPATCHED') AND lease_ends_at<now() ORDER BY lease_ends_at LIMIT 20")).rows;
 const began=Date.now();
 for(const item of expired){
  if(Date.now()-began>1000)break;
  try{await finishAi({...user,organizationId:item.organization_id,id:item.user_id},item.request_id,{errorCode:'AI_TIMEOUT'},true)}catch(error){if(!['55P03','57014'].includes(error.code))throw error}
 }
 await pool.query(`UPDATE ai_requests SET response=NULL WHERE (organization_id,user_id,request_id) IN
  (SELECT organization_id,user_id,request_id FROM ai_requests WHERE response_expires_at<now() AND response IS NOT NULL ORDER BY response_expires_at LIMIT 100)`);
}
export async function reserveAi(user,requestId,fingerprint,authorizationKey,settings){
 await recoverAiLeases(user);
 return transaction(async db=>{
  const org=await organization(db,user.organizationId),plan=planFor(org),limit=plan?.limits.aiRequests||0;
  if(!limit)throw new HttpError(403,'ZENIX AI uchun Business yoki Premium tarifini tanlang','AI_PLAN_REQUIRED');
  if(!org.writable)throw new HttpError(402,'Obuna tugagan. AI uchun tarifni faollashtiring','LICENSE_EXPIRED');
  const previous=(await db.query('SELECT * FROM ai_requests WHERE organization_id=$1 AND user_id=$2 AND request_id=$3',[org.id,user.id,requestId])).rows[0];
  if(previous){
   if(previous.fingerprint!==fingerprint)throw new HttpError(409,'So‘rov identifikatori boshqa savolda ishlatilgan','AI_IDEMPOTENCY_CONFLICT');
   if(previous.authorization_key!==authorizationKey)throw new HttpError(403,'Ruxsatlar o‘zgargan','AI_ACCESS_CHANGED');
   if(previous.status==='SUCCEEDED'&&previous.response&&new Date(previous.response_expires_at)>new Date())return {replay:previous.response};
   throw new HttpError(previous.status==='SUCCEEDED'?410:409,'Oldingi so‘rov yakunlangan yoki bajarilmoqda',previous.status==='SUCCEEDED'?'AI_RESULT_EXPIRED':previous.status==='FAILED'?'AI_REQUEST_FAILED':'AI_REQUEST_PENDING');
  }
  if(!settings.enabled)throw new HttpError(503,'AI provayderi hali faollashtirilmagan','AI_UNAVAILABLE');
  if(tokenCostMicros(settings.maxInputTokens,settings.maxOutputTokens)>settings.maxRequestMicros)throw new HttpError(503,'AI xarajat chegarasi yetarli emas','AI_COST_LIMIT');
  const cost=settings.maxRequestMicros;
  await db.query('INSERT INTO ai_daily_budget(day) VALUES($1) ON CONFLICT DO NOTHING',[org.day]);
  const daily=(await db.query('SELECT * FROM ai_daily_budget WHERE day=$1 FOR UPDATE',[org.day])).rows[0];
  await db.query('INSERT INTO ai_monthly_usage(organization_id,period_start) VALUES($1,$2) ON CONFLICT DO NOTHING',[org.id,org.period]);
  const usage=(await db.query('SELECT * FROM ai_monthly_usage WHERE organization_id=$1 AND period_start=$2 FOR UPDATE',[org.id,org.period])).rows[0];
  const rate=(await db.query(`SELECT count(*) FILTER(WHERE created_at>now()-interval '60 seconds') recent,count(*) FILTER(WHERE user_id=$2 AND created_at>now()-interval '60 seconds') user_recent,
   count(*) FILTER(WHERE status IN ('PENDING','DISPATCHED')) concurrent FROM ai_requests WHERE organization_id=$1 AND created_at>now()-interval '90 seconds'`,[org.id,user.id])).rows[0];
  if(Number(rate.recent)>=settings.businessPerMinute||Number(rate.user_recent)>=settings.userPerMinute||Number(rate.concurrent)>=settings.maxConcurrent)throw new HttpError(429,'AI so‘rovlari tezligi cheklangan. Biroz kuting','AI_RATE_LIMIT');
  if(usage.successes+usage.reserved>=limit)throw new HttpError(429,'Oylik AI so‘rovlar limiti tugagan','AI_QUOTA_EXCEEDED',{limit,used:usage.successes,reserved:usage.reserved});
  const monthly=plan.code==='PREMIUM'?settings.premiumMonthlyMicros:settings.businessMonthlyMicros;
  if(Number(usage.spent_micros)+Number(usage.reserved_micros)+cost>monthly||Number(daily.spent_micros)+Number(daily.reserved_micros)+cost>settings.dailyMicros)throw new HttpError(429,'AI xarajat limiti tugagan','AI_COST_LIMIT');
  await db.query('UPDATE ai_monthly_usage SET reserved=reserved+1,reserved_micros=reserved_micros+$3 WHERE organization_id=$1 AND period_start=$2',[org.id,org.period,cost]);
  await db.query('UPDATE ai_daily_budget SET reserved_micros=reserved_micros+$2 WHERE day=$1',[org.day,cost]);
  await db.query(`INSERT INTO ai_requests(organization_id,user_id,request_id,period_start,day,fingerprint,authorization_key,status,reserved_cost) VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)`,[org.id,user.id,requestId,org.period,org.day,fingerprint,authorizationKey,cost]);
  return {replay:null};
 });
}
export async function markAiDispatched(user,requestId){
 await transaction(async db=>{
 await organization(db,user.organizationId);
 const result=await db.query("UPDATE ai_requests SET status='DISPATCHED' WHERE organization_id=$1 AND user_id=$2 AND request_id=$3 AND status='PENDING' AND lease_ends_at>now() RETURNING request_id",[user.organizationId,user.id,requestId]);
 if(!result.rowCount)throw new HttpError(409,'AI so‘rov muddati tugagan','AI_TIMEOUT');
 });
}
export async function finishAi(user,requestId,result={},expiredOnly=false){
 return transaction(async db=>{
  if(!await organization(db,user.organizationId,expiredOnly))return;
  const row=(await db.query('SELECT * FROM ai_requests WHERE organization_id=$1 AND user_id=$2 AND request_id=$3',[user.organizationId,user.id,requestId])).rows[0];
  if(!row||!['PENDING','DISPATCHED'].includes(row.status)||expiredOnly&&new Date(row.lease_ends_at)>=new Date())return;
  await lockAccounting(db,row);await settle(db,row,result);return true;
 },{recovery:expiredOnly});
}
