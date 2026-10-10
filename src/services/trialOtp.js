import {createHmac,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {HttpError} from '../lib/http.js';
import {randomToken,sha256} from '../lib/crypto.js';
import {runTransaction} from '../db/tx.js';
import {sendOtpSms,smsConfiguration,assertSmsConfigured} from './smsProvider.js';
const invalid=()=>new HttpError(400,'Kod yoki tasdiqlash holati yaroqsiz. Qayta SMS yuboring.','OTP_INVALID');
const limited=()=>new HttpError(429,'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.','OTP_RATE_LIMITED');
const keyValue=()=>{const key=process.env.OTP_HMAC_SECRET;if(!key||Buffer.byteLength(key)<32)throw new HttpError(503,'Telefon tasdiqlash xizmati sozlanmagan','OTP_UNAVAILABLE');return key};
export function normalizeOtpPhone(value){const text=String(value||'');if(!/^\+?[\d ()-]+$/.test(text))throw invalid();const phone=text.replace(/\D/g,'');if(!/^998\d{9}$/.test(phone))throw invalid();return phone}
export function otpDigest(key,id,phoneHash,code){if(!key||Buffer.byteLength(key)<32)throw new Error('OTP HMAC key must contain at least32 bytes');return createHmac('sha256',key).update(JSON.stringify(['otp-v1',id,phoneHash,code])).digest('hex')}
export function matchesOtp(stored,received){if(!/^[a-f0-9]{64}$/.test(stored||'')||!/^[a-f0-9]{64}$/.test(received||''))return false;return timingSafeEqual(Buffer.from(stored,'hex'),Buffer.from(received,'hex'))}
const identity=(phone,ip)=>({phoneHash:sha256('phone:'+normalizeOtpPhone(phone)),ipHash:createHmac('sha256',keyValue()).update('ip:'+String(ip)).digest('hex')});
async function lockRate(client,phoneHash,ipHash,kind){
 for(const key of [`otp-ip:${ipHash}`,`otp-phone:${phoneHash}`].sort())await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
 const counts=(await client.query(`SELECT count(*) FILTER(WHERE ip_hash=$2) AS ip_count,count(*) FILTER(WHERE phone_hash=$1) AS phone_count FROM auth_otp_attempts WHERE kind=$3 AND created_at>now()-interval '1 hour' AND (phone_hash=$1 OR ip_hash=$2)`,[phoneHash,ipHash,kind])).rows[0];
 if(Number(counts.ip_count)>=(kind==='SEND'?20:60)||Number(counts.phone_count)>=(kind==='SEND'?5:25))throw limited();
 await client.query('INSERT INTO auth_otp_attempts(phone_hash,ip_hash,kind) VALUES($1,$2,$3)',[phoneHash,ipHash,kind]);
}
export async function requestTrialOtp(db,{phone,ip},send=sendOtpSms){
 const config=smsConfiguration();assertSmsConfigured(config);const key=keyValue(),normalized=normalizeOtpPhone(phone),{phoneHash,ipHash}=identity(normalized,ip),id=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0'),messageId=id.replaceAll('-','').slice(0,20);
 const row=await runTransaction(db,async client=>{
  await lockRate(client,phoneHash,ipHash,'SEND');
  if((await client.query(`SELECT 1 FROM auth_otp_challenges WHERE phone_hash=$1 AND created_at>now()-interval '60 seconds' LIMIT 1`,[phoneHash])).rowCount)throw limited();
  await client.query('UPDATE auth_otp_challenges SET consumed_at=now(),code_digest=NULL WHERE phone_hash=$1 AND consumed_at IS NULL',[phoneHash]);
  return (await client.query(`INSERT INTO auth_otp_challenges(id,phone_hash,ip_hash,code_digest,provider,provider_message_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *,created_at+interval '60 seconds' AS resend_at`,[id,phoneHash,ipHash,otpDigest(key,id,phoneHash,code),config.provider,messageId])).rows[0];
 });
 try{await send({phone:normalized,code,messageId},config);await db.query(`UPDATE auth_otp_challenges SET delivery_status='ACCEPTED' WHERE id=$1`,[id])}
 catch(error){await db.query(`UPDATE auth_otp_challenges SET delivery_status='FAILED',code_digest=NULL,consumed_at=now() WHERE id=$1`,[id]);throw error}
 return {challengeId:id,expiresAt:row.expires_at,resendAt:row.resend_at};
}
export async function verifyTrialOtp(db,{challengeId,phone,code,ip}){
 const {phoneHash,ipHash}=identity(phone,ip),key=keyValue();
 const result=await runTransaction(db,async client=>{
  await lockRate(client,phoneHash,ipHash,'VERIFY');
  const row=(await client.query(`SELECT *,expires_at>now() AS live FROM auth_otp_challenges WHERE id=$1 AND phone_hash=$2 FOR UPDATE`,[challengeId,phoneHash])).rows[0];
  if(!row||!row.live||row.consumed_at||row.verified_at||row.delivery_status!=='ACCEPTED'||row.attempts>=5)return {error:invalid()};
  if(!matchesOtp(row.code_digest,otpDigest(key,challengeId,phoneHash,code))){await client.query('UPDATE auth_otp_challenges SET attempts=attempts+1,code_digest=CASE WHEN attempts=4 THEN NULL ELSE code_digest END WHERE id=$1',[challengeId]);return {error:invalid()}}
  const token=randomToken(32);const verified=(await client.query(`UPDATE auth_otp_challenges SET verified_at=now(),code_digest=NULL,registration_token_hash=$2,registration_expires_at=now()+interval '5 minutes' WHERE id=$1 RETURNING registration_expires_at`,[challengeId,sha256(token)])).rows[0];
  return {registrationToken:token,expiresAt:verified.registration_expires_at};
 });
 if(result.error)throw result.error;return result;
}
// Must run in the SAME transaction as organization creation and trial claim.
export async function consumeTrialVerification(client,{phone,registrationToken}){
 assertSmsConfigured(smsConfiguration());keyValue();
 if(!/^[A-Za-z0-9_-]{43}$/.test(registrationToken||''))throw new HttpError(400,'Sinov uchun telefonni SMS orqali tasdiqlang','OTP_REQUIRED');
 const phoneHash=sha256('phone:'+normalizeOtpPhone(phone));
 const consumed=await client.query(`UPDATE auth_otp_challenges SET consumed_at=now() WHERE registration_token_hash=$1 AND phone_hash=$2 AND verified_at IS NOT NULL AND consumed_at IS NULL AND registration_expires_at>now() RETURNING id,verified_at`,[sha256(registrationToken),phoneHash]);
 if(!consumed.rowCount)throw invalid();
 return consumed.rows[0];
}
// Call only through an explicitly authorized maintenance job; never deletes trial claims.
export async function pruneExpiredOtpState(client){
 const challenges=await client.query("DELETE FROM auth_otp_challenges WHERE expires_at<now()-interval '7 days' AND (registration_expires_at IS NULL OR registration_expires_at<now()-interval '7 days')");
 const attempts=await client.query("DELETE FROM auth_otp_attempts WHERE created_at<now()-interval '48 hours'");
 return {challenges:challenges.rowCount,attempts:attempts.rowCount};
}
