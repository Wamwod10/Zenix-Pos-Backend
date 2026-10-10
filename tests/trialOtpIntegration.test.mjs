import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
(url?test:test.skip)('real PG/HTTP OTP security and atomic trial registration (test SMS adapter)',{timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});assert.equal(process.env.DATABASE_URL,url);
 process.env.SMS_PROVIDER='test';process.env.OTP_HMAC_SECRET=randomBytes(48).toString('base64url');
 const [{app},{pool},otp,sms,{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/services/trialOtp.js'),import('../src/services/smsProvider.js'),import('../src/lib/crypto.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const phone=()=> '99890'+String(randomInt(1000000,9999999));
 const request=async(path,body)=>{const r=await fetch(base+'/api/auth'+path,{method:'POST',headers:{'content-type':'application/json','x-zenix-client':'web','x-forwarded-for':'192.0.2.'+randomInt(1,250)},body:JSON.stringify(body)});return {status:r.status,...await r.json()}};
 const challenge=async(p=phone())=>{const value=await otp.requestTrialOtp(pool,{phone:p,ip:randomUUID()});const row=(await pool.query('SELECT * FROM auth_otp_challenges WHERE id=$1',[value.challengeId])).rows[0];const delivered=sms.takeTestSms(row.provider_message_id);assert.ok(delivered);assert.notEqual(row.code_digest,sha256(delivered.code));assert.equal(row.code_digest.length,64);return {phone:p,code:delivered.code,challengeId:value.challengeId}};
 const verified=async(p)=>{const c=await challenge(p);const value=await otp.verifyTrialOtp(pool,{...c,ip:randomUUID()});return {...c,...value}};
 const registration=(proof,username='otp-'+randomUUID())=>({businessName:'Disposable OTP trial',ownerName:'OTP owner',phone:proof.phone,username,password:randomUUID()+'Aa1!',startOption:'TRIAL',registrationToken:proof.registrationToken});
 try{
 await t.test('missing proof denied and paid registrations remain available',async()=>{
  const denied=await request('/register',registration({phone:phone()}));assert.equal(denied.status,400);assert.equal(denied.error.code,'OTP_REQUIRED');
  for(const startOption of ['MONTHLY','ANNUAL']){const r=await request('/register',{...registration({phone:phone()}),startOption});assert.equal(r.status,201);const o=(await pool.query('SELECT license_status FROM organizations WHERE id=$1',[r.data.user.organizationId])).rows[0];assert.equal(o.license_status,'PAYMENT_REQUIRED')}
 });
 await t.test('wrong code attempts persist, fifth locks correct code, expired and reused code denied',async()=>{
  const c=await challenge(),wrong=c.code==='000000'?'000001':'000000';for(let i=0;i<5;i++)await assert.rejects(()=>otp.verifyTrialOtp(pool,{...c,code:wrong,ip:randomUUID()}),e=>e.code==='OTP_INVALID');
  assert.equal((await pool.query('SELECT attempts FROM auth_otp_challenges WHERE id=$1',[c.challengeId])).rows[0].attempts,5);await assert.rejects(()=>otp.verifyTrialOtp(pool,{...c,ip:randomUUID()}));
  const expired=await challenge();await pool.query("UPDATE auth_otp_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.challengeId]);await assert.rejects(()=>otp.verifyTrialOtp(pool,{...expired,ip:randomUUID()}));
  const reuse=await verified();await assert.rejects(()=>otp.verifyTrialOtp(pool,{...reuse,ip:randomUUID()}));
 });
 await t.test('resend cooldown and invalidation; one parallel verification; token expiry/changed phone',async()=>{
  const old=await challenge();await assert.rejects(()=>otp.requestTrialOtp(pool,{phone:old.phone,ip:randomUUID()}),e=>e.status===429);
  await pool.query("UPDATE auth_otp_challenges SET created_at=now()-interval '61 seconds' WHERE id=$1",[old.challengeId]);const fresh=await challenge(old.phone);await assert.rejects(()=>otp.verifyTrialOtp(pool,{...old,ip:randomUUID()}));
  const results=await Promise.allSettled([1,2].map(()=>otp.verifyTrialOtp(pool,{...fresh,ip:randomUUID()})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const proof=results.find(r=>r.status==='fulfilled').value;const changed=await request('/register',registration({...proof,phone:phone()}));assert.equal(changed.status,400);
  await pool.query("UPDATE auth_otp_challenges SET registration_expires_at=now()-interval '1 second' WHERE id=$1",[fresh.challengeId]);assert.equal((await request('/register',registration({...proof,phone:fresh.phone}))).status,400);
 });
 await t.test('parallel registrations one organization; phone trial claim and token consumption atomic',async()=>{
  const proof=await verified(),before=Number((await pool.query('SELECT count(*) FROM organizations')).rows[0].count);
  const results=await Promise.all([1,2].map(()=>request('/register',registration(proof))));assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);assert.equal(Number((await pool.query('SELECT count(*) FROM organizations')).rows[0].count),before+1);
  const org=results.find(r=>r.status===201).data.user.organizationId;const row=(await pool.query('SELECT settings FROM organizations WHERE id=$1',[org])).rows[0];assert.equal(Date.parse(row.settings.trialEndsAt)-Date.parse(row.settings.trialStartedAt),14*86400000);
  await pool.query("UPDATE auth_otp_challenges SET created_at=now()-interval '61 seconds' WHERE phone_hash=$1",[sha256('phone:'+proof.phone)]);const reused=await verified(proof.phone);const rejected=await request('/register',registration(reused));assert.equal(rejected.status,409);assert.equal(rejected.error.code,'TRIAL_ALREADY_USED');assert.equal((await pool.query('SELECT consumed_at FROM auth_otp_challenges WHERE id=$1',[reused.challengeId])).rows[0].consumed_at,null);
  const unique=await verified(),name='occupied-'+randomUUID();const paid=await request('/register',{...registration({phone:phone()},name),startOption:'MONTHLY'});assert.equal(paid.status,201);assert.equal((await request('/register',registration(unique,name))).status,409);assert.equal((await pool.query('SELECT consumed_at FROM auth_otp_challenges WHERE id=$1',[unique.challengeId])).rows[0].consumed_at,null);assert.equal((await request('/register',registration(unique))).status,201);
 });
 await t.test('provider failure invalidates challenge and IP limit serializes concurrent sends',async()=>{
  const p=phone();await assert.rejects(()=>otp.requestTrialOtp(pool,{phone:p,ip:randomUUID()},async()=>{throw new Error('test delivery outage')}));assert.equal((await pool.query('SELECT delivery_status,code_digest FROM auth_otp_challenges WHERE phone_hash=$1',[sha256('phone:'+p)])).rows[0].code_digest,null);
  const ip=randomUUID(),key=process.env.OTP_HMAC_SECRET;const {createHmac}=await import('node:crypto');const ipHash=createHmac('sha256',key).update('ip:'+ip).digest('hex');await pool.query("INSERT INTO auth_otp_attempts(phone_hash,ip_hash,kind) SELECT $1,$2,'SEND' FROM generate_series(1,19)",[sha256('phone:'+phone()),ipHash]);const results=await Promise.allSettled([1,2].map(()=>otp.requestTrialOtp(pool,{phone:phone(),ip})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const saved=process.env.SMS_PROVIDER;process.env.SMS_PROVIDER='';try{assert.equal((await request('/otp/request',{phone:phone()})).status,503)}finally{process.env.SMS_PROVIDER=saved}
 });
 }finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
});
