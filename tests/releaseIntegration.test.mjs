import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {SUBSCRIPTION_CATALOG} from '../src/config/subscriptions.js';
const url=process.env.RELEASE_TEST_DATABASE_URL;
test('release: DB/catalog/API prices, all standard modules, read-only and AI entitlements',{skip:!url,timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.DATABASE_URL,url);assert.equal(process.env.NODE_ENV,'test');
 const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,token,method='GET',body){const r=await fetch(base+path,{method,headers:{cookie:`zenix_session=${token}`,'content-type':'application/json','x-zenix-client':'web',origin:'http://localhost:5173'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,...await r.json()}}
 try{
  for(const plan of Object.values(SUBSCRIPTION_CATALOG[1]))await t.test(plan.code,async()=>{
   const row=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date,settings) VALUES('Release fixture',$1,'ACTIVE','2099-01-01',jsonb_build_object('trialStartedAt',now()::text,'trialEndsAt',(now()+interval '14 days')::text)) RETURNING id",[plan.code])).rows[0];
   const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Main') RETURNING id",[row.id])).rows[0].id;
   const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Owner',$3,'synthetic','OWNER') RETURNING id",[row.id,store,randomUUID()])).rows[0].id;
   const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')",[user,sha256(token)]);
   const snapshot=(await pool.query('SELECT * FROM subscription_plan_versions WHERE plan_code=$1 AND version=1',[plan.code])).rows[0];
   assert.equal(Number(snapshot.monthly_amount),plan.prices.MONTHLY);assert.equal(Number(snapshot.annual_amount),plan.prices.ANNUAL);assert.deepEqual(snapshot.limits,plan.limits);if(plan.code==='START')assert.equal(snapshot.limits.products,750);
   const catalogue=await request('/api/billing/plans',token);assert.equal(catalogue.status,200);assert.deepEqual(catalogue.data.plans,Object.values(SUBSCRIPTION_CATALOG[1]));
   const resources=await request('/api/billing/limits',token);assert.equal(resources.status,200);for(const key of ['employees','stores','warehouses','registers','products','customers'])assert.equal(resources.data.resources[key].limit,plan.limits[key]);
   for(const route of ['/api/bootstrap','/api/products','/api/customers','/api/finance','/api/suppliers','/api/users','/api/registers',`/api/warehouses?storeId=${store}`])assert.equal((await request(route,token)).status,200,`${plan.code} module ${route}`);
   const ai=await request('/api/ai/status',token);assert.equal(ai.status,200);assert.equal(ai.data.limit,plan.limits.aiRequests);assert.equal(ai.data.enabled,false);
   await pool.query("UPDATE organizations SET settings=jsonb_set(settings,'{trialEndsAt}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1",[row.id]);
   for(const route of ['/api/bootstrap','/api/products','/api/finance','/api/billing/plans','/api/ai/status'])assert.equal((await request(route,token)).status,200,`read-only ${route}`);
   for(const [route,method,body] of [['/api/products','POST',{name:'Denied',sellPrice:10}],['/api/users','POST',{}],['/api/inventory/receive','POST',{}],['/api/sales','POST',{}],['/api/warehouses','POST',{}],['/api/registers','POST',{}],['/api/ai/chat','POST',{requestId:randomUUID(),question:'Bugun qancha savdo bo‘ldi?'}]])assert.equal((await request(route,token,method,body)).status,402,`write blocked ${route}`);
   assert.equal((await pool.query('SELECT count(*) FROM products WHERE organization_id=$1',[row.id])).rows[0].count,'0');
  });
 }finally{await new Promise(r=>server.close(r));await pool.end()}
});
