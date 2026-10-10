import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { env } from "../config/env.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { assertLoginAllowed, recordLoginDecision } from "../services/loginThrottle.js";
import { organizationCalendarDateISO } from "../lib/businessDate.js";
import {consumePasswordReset} from '../services/passwordReset.js';
import {requestTrialOtp,verifyTrialOtp,consumeTrialVerification,normalizeOtpPhone} from '../services/trialOtp.js';
import {writeAudit} from '../services/audit.js';

export function trialPeriod(organization,now=new Date()){
  const expiry=new Date(`${organizationCalendarDateISO(organization,now)}T12:00:00Z`);
  expiry.setUTCDate(expiry.getUTCDate()+14);
  return {expiryDate:expiry.toISOString().slice(0,10),settings:{trialStartedAt:now.toISOString(),trialEndsAt:new Date(now.getTime()+14*86400000).toISOString(),trialUsed:true}};
}

const router=Router();
const cookieOptions={httpOnly:true,secure:env.isProduction,sameSite:env.isProduction?"none":"lax",path:"/",maxAge:env.sessionTtlDays*86400000};
const loginSchema=z.object({username:z.string().trim().min(1).max(120),password:z.string().min(1).max(300)});
export const registerSchema=z.object({businessName:z.string().trim().min(2).max(160),ownerName:z.string().trim().min(2).max(160),phone:z.string().trim().max(40).refine(value=>/^998\d{9}$/.test(value.replace(/\D/g,'')),'Telefon raqamini to‘liq kiriting'),username:z.string().trim().min(3).max(120),password:z.string().min(8).max(300),startOption:z.enum(["TRIAL","MONTHLY","ANNUAL"]).default("TRIAL"),registrationToken:z.string().max(100).optional()});

export async function claimOrganizationTrial(client,organizationId,phone){
  const phoneHash=sha256(`phone:${phone.replace(/\D/g,'')}`);
  const result=await client.query('INSERT INTO organization_trial_claims(organization_id,phone_hash) VALUES($1,$2) ON CONFLICT(phone_hash) DO NOTHING RETURNING organization_id',[organizationId,phoneHash]);
  if(!result.rowCount)throw new HttpError(409,'Bu biznes telefoni sinovdan foydalangan. Pullik tarifni tanlang','TRIAL_ALREADY_USED');
}

const publicUser=(row)=>({id:row.id,organizationId:row.organization_id,organizationName:row.organization_name||row.organizationName||"",storeId:row.store_id,name:row.name,username:row.username,phone:row.phone,appRole:row.app_role,permissionOverrides:row.permission_overrides||{},mustChangePassword:Boolean(row.must_change_password),forcePasswordChange:Boolean(row.must_change_password)});

async function createSession(client,userId,req){
  // All callers must use an open transaction. Serialize concurrent logins for
  // one account so the 20-session ceiling cannot be bypassed by racing inserts.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`session:${userId}`]);
  const raw=randomToken(40),hash=sha256(raw);
  const expiresAt=new Date(Date.now()+env.sessionTtlDays*86400000);
  await client.query(`INSERT INTO auth_sessions(user_id,token_hash,user_agent,ip_address,expires_at) VALUES($1,$2,$3,$4,$5)`,[userId,hash,String(req.get("user-agent")||"").slice(0,500),req.ip||null,expiresAt]);
  // Keep a bounded number of live sessions per account so forgotten devices do not
  // accumulate indefinitely. The newest 20 sessions remain valid.
  await client.query(`UPDATE auth_sessions SET revoked_at=now()
    WHERE id IN (
      SELECT id FROM auth_sessions
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
      ORDER BY created_at DESC OFFSET 20
    )`,[userId]);
  return raw;
}

const registrationWindow="1 hour";
const maxRegistrationsPerIp=8;
const requestIp=(req)=>String(req.ip||req.socket?.remoteAddress||"unknown").slice(0,120);
async function recordRegistrationAttempt(ipAddress){
  await withTransaction(async(client)=>{
    // Serialize registrations from the same network so simultaneous requests cannot
    // race past the rate limit before their ledger rows become visible.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`register:${ipAddress}`]);
    const inserted=await client.query(`INSERT INTO auth_registration_attempts(ip_address)
      SELECT $1
      WHERE (SELECT count(*) FROM auth_registration_attempts WHERE ip_address=$1 AND created_at>now()-$2::interval)<$3
      RETURNING id`,[ipAddress,registrationWindow,maxRegistrationsPerIp]);
    if(!inserted.rowCount)throw new HttpError(429,"Bu tarmoqdan juda ko‘p ro‘yxatdan o‘tish urinishi bo‘ldi. Birozdan keyin qayta urinib ko‘ring.","REGISTRATION_RATE_LIMITED");
  });
  pool.query("DELETE FROM auth_registration_attempts WHERE created_at<now()-interval '48 hours'").catch(()=>{});
}

router.post('/otp/request',asyncRoute(async(req,res)=>{
  const input=z.object({phone:z.string().max(40)}).strict().parse(req.body);
  ok(res,await requestTrialOtp(pool,{phone:normalizeOtpPhone(input.phone),ip:requestIp(req)}));
}));
router.post('/otp/verify',asyncRoute(async(req,res)=>{
  const input=z.object({challengeId:z.string().uuid(),phone:z.string().max(40),code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body);
  ok(res,await verifyTrialOtp(pool,{...input,ip:requestIp(req)}));
}));
router.post("/register",asyncRoute(async(req,res)=>{
  const input=registerSchema.parse(req.body);
  await recordRegistrationAttempt(requestIp(req));
  const result=await withTransaction(async(client)=>{
    const verification=input.startOption==='TRIAL'?await consumeTrialVerification(client,input):null;
    const passwordHash=await bcrypt.hash(input.password,12);
    // Read the database's organization timezone before deriving any trial date.
    const org=(await client.query(`INSERT INTO organizations(name,phone) VALUES($1,$2) RETURNING *`,[input.businessName,input.phone])).rows[0];
    if(input.startOption==='TRIAL')await claimOrganizationTrial(client,org.id,input.phone);
    const trial=input.startOption==='TRIAL'?trialPeriod(org,new Date(org.created_at)):null;
    if(trial)trial.settings.phoneVerifiedAt=verification.verified_at;
    await client.query(`UPDATE organizations SET plan=$2,license_status=$3,expiry_date=$4,settings=$5::jsonb WHERE id=$1`,[org.id,input.startOption==='MONTHLY'?'MONTHLY':'ANNUAL',trial?'ACTIVE':'PAYMENT_REQUIRED',trial?.expiryDate||null,JSON.stringify(trial?.settings||{trialUsed:false})]);
    const store=(await client.query(`INSERT INTO stores(organization_id,name) VALUES($1,'Asosiy filial') RETURNING *`,[org.id])).rows[0];
    const user=(await client.query(`INSERT INTO users(organization_id,store_id,name,username,phone,password_hash,app_role) VALUES($1,$2,$3,$4,$5,$6,'OWNER') RETURNING *`,[org.id,store.id,input.ownerName,input.username.toLowerCase(),input.phone,passwordHash])).rows[0];
    if(verification)await writeAudit(client,{organizationId:org.id,userId:user.id,storeId:store.id,action:'trial_phone_verified',entityType:'organization',entityId:org.id,title:'Trial phone verified',metadata:{challengeId:verification.id}});
    const token=await createSession(client,user.id,req);
    return {token,user:{...user,organization_name:org.name}};
  });
  res.cookie(env.sessionCookieName,result.token,cookieOptions);
  ok(res,{user:publicUser(result.user)},201);
}));

router.post("/login",asyncRoute(async(req,res)=>{
  const input=loginSchema.parse(req.body);
  const usernameNorm=input.username.trim().toLowerCase();
  const ipAddress=requestIp(req);
  await assertLoginAllowed(pool,usernameNorm,ipAddress);
  const {rows}=await pool.query(`SELECT u.*,o.name AS organization_name,o.license_status AS organization_license_status FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE lower(u.username)=lower($1) AND u.active=true ORDER BY u.created_at LIMIT 1`,[usernameNorm]);
  const user=rows[0];
  const valid=Boolean(user)&&await bcrypt.compare(input.password,user.password_hash);
  await recordLoginDecision(pool,{usernameNorm,ipAddress,success:valid});
  if(!valid){
    throw new HttpError(401,"Kirish nomi yoki parol noto‘g‘ri","INVALID_CREDENTIALS");
  }
  if(user.organization_license_status==="SUSPENDED")throw new HttpError(403,"Akkaunt administrator tomonidan bloklangan","ACCOUNT_SUSPENDED");
  const result=await withTransaction(async(client)=>{
    // Credential writers lock this same user row before updating the hash and
    // revoking sessions. A bcrypt result from before that lock is only a hint.
    const current=(await client.query(`SELECT u.*,o.name AS organization_name,o.license_status AS organization_license_status
      FROM users u LEFT JOIN organizations o ON o.id=u.organization_id
      WHERE u.id=$1 FOR UPDATE OF u`,[user.id])).rows[0];
    if(!current||!current.active||current.password_hash!==user.password_hash||
      Boolean(current.must_change_password)!==Boolean(user.must_change_password)||
      current.organization_id!==user.organization_id||String(current.username).toLowerCase()!==usernameNorm){
      throw new HttpError(401,"Kirish nomi yoki parol noto‘g‘ri","INVALID_CREDENTIALS");
    }
    if(current.organization_license_status==="SUSPENDED")throw new HttpError(403,"Akkaunt administrator tomonidan bloklangan","ACCOUNT_SUSPENDED");
    return {token:await createSession(client,current.id,req),user:current};
  });
  res.cookie(env.sessionCookieName,result.token,cookieOptions);
  ok(res,{user:publicUser(result.user)});
}));

router.post('/reset-password',asyncRoute(async(req,res)=>{
  const input=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),password:z.string().min(12).max(128)}).strict().parse(req.body);
  const ip=requestIp(req),key=`password-reset:${ip}`;
  await assertLoginAllowed(pool,key,ip);
  // Count attempts before work so parallel invalid tokens cannot bypass limits.
  await recordLoginDecision(pool,{usernameNorm:key,ipAddress:ip,success:false});
  const hash=await bcrypt.hash(input.password,12);
  await withTransaction(client=>consumePasswordReset(client,{token:input.token,passwordHash:hash}));
  res.clearCookie(env.sessionCookieName,{...cookieOptions,maxAge:undefined});
  ok(res,{success:true});
}));
router.post("/logout",requireAuth,asyncRoute(async(req,res)=>{
  await pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[req.user.sessionId]);
  res.clearCookie(env.sessionCookieName,{...cookieOptions,maxAge:undefined});
  ok(res,{success:true});
}));
router.get("/me",requireAuth,asyncRoute(async(req,res)=>ok(res,{user:req.user})));

export default router;
