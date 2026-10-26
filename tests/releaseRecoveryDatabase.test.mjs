import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {runTransaction} from '../src/db/tx.js';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {recoveryRowManifest,compareRecoveryRowManifests} from '../src/services/tenantRecovery.js';
import {auditTenantIntegrity} from '../src/db/auditIntegrity.js';
const url=process.env.RELEASE_RECOVERY_TEST_DATABASE_URL;
test('real PG restore manifests include all modern financial/quota/register state',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);const db=new pg.Pool({connectionString:url});
 try{
  const org=await runTransaction(db,async setup=>{
  const org=(await setup.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Recovery manifest fixture','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  const user=(await setup.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Fixture owner',$2,'unused','OWNER') RETURNING id",[org,randomUUID()])).rows[0].id;
  const store=(await setup.query("INSERT INTO stores(organization_id,name) VALUES($1,'Fixture branch') RETURNING id",[org])).rows[0].id;
  await setup.query("INSERT INTO pos_registers(organization_id,store_id,name,register_key) VALUES($1,$2,'Fixture POS',$3)",[org,store,randomUUID()]);
  const payment=(await setup.query("INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,status) VALUES($1,$2,'LICENSE','MONTHLY',350000,'APPROVED') RETURNING id",[org,randomUUID()])).rows[0].id;
  await setup.query("INSERT INTO subscription_terms(organization_id,payment_id,plan_code,pricing_version,billing_interval,starts_on,ends_on,value_amount) VALUES($1,$2,'BUSINESS',1,'MONTHLY',CURRENT_DATE,CURRENT_DATE+30,350000)",[org,payment]);
  await setup.query("INSERT INTO subscription_events(organization_id,payment_id,event_type,payload) VALUES($1,$2,'ACTIVATE','{}')",[org,payment]);
  await setup.query("INSERT INTO ai_monthly_usage(organization_id,period_start,successes) VALUES($1,'2000-01-01',1)",[org]);
  await setup.query("INSERT INTO ai_daily_budget(day) VALUES('2000-01-01') ON CONFLICT DO NOTHING");
  await setup.query("INSERT INTO ai_requests(organization_id,user_id,request_id,period_start,day,fingerprint,authorization_key,status,reserved_cost,actual_cost) VALUES($1,$2,$3,'2000-01-01','2000-01-01','fixture','fixture','SUCCEEDED',0,0)",[org,user,randomUUID()]);
  await setup.query("INSERT INTO financial_write_replays(organization_id,operation,client_reference,user_id,request_fingerprint,result) VALUES($1,'expense_create',$2,$3,'fixture','{}')",[org,randomUUID(),user]);
  return org;
  });
  const manifest=await recoveryRowManifest(db,org);
  assert.ok(Object.values(await auditTenantIntegrity(db)).every(count=>count===0));
  for(const table of ['subscription_terms','subscription_events','pos_registers','ai_monthly_usage','ai_requests','subscription_plan_versions','ai_daily_budget','financial_write_replays']){
   assert.ok(manifest.tables[table]);const changed=structuredClone(manifest);changed.tables[table].fingerprint='a'.repeat(64);
   assert.ok(manifest.tables[table].rows>0,`Populated synthetic restore fixture required: ${table}`);
   assert.ok(compareRecoveryRowManifests(manifest,changed).differences.some(d=>d.table===table));
  }
 }finally{await db.end()}
});
