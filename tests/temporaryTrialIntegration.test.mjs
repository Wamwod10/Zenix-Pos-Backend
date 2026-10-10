import test from 'node:test';
import assert from 'node:assert/strict';
import {randomInt,randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
(url?test:test.skip)('temporary trial real PostgreSQL/HTTP admission and expiry',{timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});assert.equal(process.env.DATABASE_URL,url);
 const saved={};for(const key of ['TRIAL_PHONE_VERIFICATION_MODE','TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL'])saved[key]=process.env[key];
 process.env.TRIAL_PHONE_VERIFICATION_MODE='temporary_disabled';process.env.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL=new Date(Date.now()+3600000).toISOString();
 const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const phone=()=>'+99890'+randomInt(1000000,9999999);
 const body=p=>({businessName:'Temporary trial fixture',ownerName:'Test owner',phone:p,username:'temporary-'+randomUUID(),password:randomUUID()+'Aa1!',startOption:'TRIAL',phoneVerified:true});
 const request=async(data,ip='198.19.'+randomInt(1,254)+'.'+randomInt(1,254))=>{const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json','x-zenix-client':'web','x-forwarded-for':ip},body:JSON.stringify(data)});return{status:r.status,cookie:r.headers.get('set-cookie'),...await r.json()}};
 try{
  await t.test('no SMS creates exactly 14 days but never verified; login/logout and audit',async()=>{
   const input=body(phone()),r=await request(input);assert.equal(r.status,201);
   const org=(await pool.query('SELECT settings,license_status FROM organizations WHERE id=$1',[r.data.user.organizationId])).rows[0];
   assert.equal(org.license_status,'ACTIVE');assert.equal(org.settings.trialPhoneVerification,'TEMPORARILY_UNVERIFIED');assert.equal(org.settings.phoneVerifiedAt,undefined);assert.equal(Date.parse(org.settings.trialEndsAt)-Date.parse(org.settings.trialStartedAt),14*86400000);
   assert.equal((await pool.query("SELECT count(*) FROM audit_logs WHERE organization_id=$1 AND action='trial_phone_verification_deferred'",[r.data.user.organizationId])).rows[0].count,'1');
   const headers={'content-type':'application/json','x-zenix-client':'web',cookie:r.cookie.split(';')[0]};
   assert.equal((await fetch(base+'/api/auth/me',{headers})).status,200);assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers})).status,200);assert.equal((await fetch(base+'/api/auth/me',{headers})).status,401);
   const login=await fetch(base+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({username:input.username,password:input.password})});assert.equal(login.status,200);
  });
  await t.test('parallel same phone gives one claim/organization and preserves existing phone claims',async()=>{
   const p=phone(),results=await Promise.all([1,2].map(()=>request(body(p))));assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
   assert.equal((await pool.query('SELECT count(*) FROM organization_trial_claims WHERE phone_hash=$1',[sha256('phone:'+p.replace(/\D/g,''))])).rows[0].count,'1');
   assert.equal((await pool.query('SELECT count(*) FROM organizations WHERE phone=$1',[p])).rows[0].count,'1');
   assert.equal((await request(body(p))).status,409);
  });
  await t.test('phone limit across IPs and IP limit serialize, including failed attempts',async()=>{
   const p=phone(),hash=sha256('phone:'+p.replace(/\D/g,''));await pool.query('INSERT INTO auth_registration_attempts(ip_address,phone_hash) SELECT $1,$2 FROM generate_series(1,4)',['fixture-'+randomUUID(),hash]);
   const rs=await Promise.all([1,2].map(()=>request(body(p))));assert.deepEqual(rs.map(r=>r.status).sort(),[201,429]);
   const ip='198.19.'+randomInt(1,254)+'.'+randomInt(1,254);await pool.query('INSERT INTO auth_registration_attempts(ip_address) SELECT $1 FROM generate_series(1,7)',[ip]);
   assert.deepEqual((await Promise.all([1,2].map(()=>request(body(phone()),ip)))).map(r=>r.status).sort(),[201,429]);
  });
  await t.test('server switch and cutoff require OTP despite forged client flags; paid unaffected',async()=>{
   process.env.TRIAL_PHONE_VERIFICATION_MODE='required';assert.equal((await request(body(phone()))).error.code,'OTP_REQUIRED');
   process.env.TRIAL_PHONE_VERIFICATION_MODE='temporary_disabled';process.env.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL=new Date(Date.now()-1000).toISOString();
   const config=await(await fetch(base+'/api/auth/registration-config')).json();assert.equal(config.data.phoneVerificationRequired,true);assert.equal((await request(body(phone()))).error.code,'OTP_REQUIRED');
   for(const startOption of ['MONTHLY','ANNUAL'])assert.equal((await request({...body(phone()),startOption})).status,201);
  });
 }finally{await new Promise(r=>server.close(r));await pool.end();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
});
