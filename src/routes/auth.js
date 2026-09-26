import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { env } from "../config/env.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";

const router=Router();
const cookieOptions={httpOnly:true,secure:env.isProduction,sameSite:env.isProduction?"none":"lax",path:"/",maxAge:env.sessionTtlDays*86400000};
const loginSchema=z.object({username:z.string().trim().min(1).max(120),password:z.string().min(1).max(300)});
const registerSchema=z.object({businessName:z.string().trim().min(2).max(160),ownerName:z.string().trim().min(2).max(160),phone:z.string().trim().min(5).max(40),username:z.string().trim().min(3).max(120),password:z.string().min(8).max(300)});

const publicUser=(row)=>({id:row.id,organizationId:row.organization_id,organizationName:row.organization_name||row.organizationName||"",storeId:row.store_id,name:row.name,username:row.username,phone:row.phone,appRole:row.app_role,permissionOverrides:row.permission_overrides||{},mustChangePassword:Boolean(row.must_change_password),forcePasswordChange:Boolean(row.must_change_password)});

async function createSession(client,userId,req){
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

const loginWindow="15 minutes";
const maxLoginFailures=8;
const registrationWindow="1 hour";
const maxRegistrationsPerIp=8;
const requestIp=(req)=>String(req.ip||req.socket?.remoteAddress||"unknown").slice(0,120);
async function assertLoginAllowed(usernameNorm,ipAddress){
  const row=(await pool.query(`SELECT count(*)::int AS failures
    FROM auth_login_attempts
    WHERE username_norm=$1 AND ip_address=$2 AND success=false
      AND created_at>now()-$3::interval`,[usernameNorm,ipAddress,loginWindow])).rows[0];
  if(Number(row?.failures||0)>=maxLoginFailures){
    throw new HttpError(429,"Juda ko‘p noto‘g‘ri urinish. Birozdan keyin qayta urinib ko‘ring.","LOGIN_RATE_LIMITED");
  }
}
async function recordLoginAttempt(usernameNorm,ipAddress,success){
  await pool.query(`INSERT INTO auth_login_attempts(username_norm,ip_address,success) VALUES($1,$2,$3)`,[usernameNorm,ipAddress,Boolean(success)]);
  // Opportunistic cleanup keeps this security ledger bounded without a separate cron.
  pool.query("DELETE FROM auth_login_attempts WHERE created_at<now()-interval '24 hours'").catch(()=>{});
}
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

router.post("/register",asyncRoute(async(req,res)=>{
  const input=registerSchema.parse(req.body);
  await recordRegistrationAttempt(requestIp(req));
  const result=await withTransaction(async(client)=>{
    const passwordHash=await bcrypt.hash(input.password,12);
    const org=(await client.query(`INSERT INTO organizations(name,phone) VALUES($1,$2) RETURNING *`,[input.businessName,input.phone])).rows[0];
    const store=(await client.query(`INSERT INTO stores(organization_id,name) VALUES($1,'Asosiy filial') RETURNING *`,[org.id])).rows[0];
    const user=(await client.query(`INSERT INTO users(organization_id,store_id,name,username,phone,password_hash,app_role) VALUES($1,$2,$3,$4,$5,$6,'OWNER') RETURNING *`,[org.id,store.id,input.ownerName,input.username.toLowerCase(),input.phone,passwordHash])).rows[0];
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
  await assertLoginAllowed(usernameNorm,ipAddress);
  const {rows}=await pool.query(`SELECT u.*,o.name AS organization_name FROM users u LEFT JOIN organizations o ON o.id=u.organization_id WHERE lower(u.username)=lower($1) AND u.active=true ORDER BY u.created_at LIMIT 1`,[usernameNorm]);
  const user=rows[0];
  const valid=Boolean(user)&&await bcrypt.compare(input.password,user.password_hash);
  if(!valid){
    await recordLoginAttempt(usernameNorm,ipAddress,false);
    throw new HttpError(401,"Kirish nomi yoki parol noto‘g‘ri","INVALID_CREDENTIALS");
  }
  await recordLoginAttempt(usernameNorm,ipAddress,true);
  await pool.query("DELETE FROM auth_login_attempts WHERE username_norm=$1 AND ip_address=$2 AND success=false",[usernameNorm,ipAddress]);
  const client=await pool.connect();let token;
  try{token=await createSession(client,user.id,req)}finally{client.release()}
  res.cookie(env.sessionCookieName,token,cookieOptions);
  ok(res,{user:publicUser(user)});
}));

router.post("/logout",requireAuth,asyncRoute(async(req,res)=>{
  await pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1",[req.user.sessionId]);
  res.clearCookie(env.sessionCookieName,{...cookieOptions,maxAge:undefined});
  ok(res,{success:true});
}));
router.get("/me",requireAuth,asyncRoute(async(req,res)=>ok(res,{user:req.user})));

export default router;
