import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {runMigrations,checkMigrationStatus} from '../src/db/migrationRunner.js';
import {verifyDatabaseSchema} from '../src/db/verifySchema.js';
const url=process.env.SUBSCRIPTION_MIGRATION_TEST_DATABASE_URL;
test('001–032 license, payment and shift history survive 033–035 and repeat migration execution',{skip:!url,timeout:60000},async()=>{
  assertSafeTestDatabaseUrl(url);const db=new pg.Pool({connectionString:url});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zenix-subscription-migration-'));
  try{
    assert.equal((await db.query("SELECT count(*) count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count,'0','A separate empty test database is required');
    const source=path.resolve('migrations');const files=(await fs.readdir(source)).filter(x=>/^\d{3}_.*\.sql$/.test(x)).sort();
    for(const file of files.filter(x=>Number(x.slice(0,3))<=32))await fs.copyFile(path.join(source,file),path.join(directory,file));
    await runMigrations({pool:db,directory,logger:{}});
    const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES('Legacy migration fixture','ACTIVE','2027-01-31',4) RETURNING *")).rows[0];
    const payment=(await db.query("INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,status,service_period_from,service_period_to) VALUES($1,$2,'LICENSE','ANNUAL',3300000,'APPROVED','2026-02-01','2027-01-31') RETURNING *",[org.id,randomUUID()])).rows[0];
    const legacyColumns='id,name,license_status,expiry_date,store_limit,plan,settings';
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Historic main') RETURNING id",[org.id])).rows[0].id;
    const user=(await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Owner',$2,'test','OWNER') RETURNING id",[org.id,randomUUID()])).rows[0].id;
    await db.query("INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,status,opening_cash,closed_at) VALUES($1,$2,$3,'historic-a','closed',12000,now()),($1,$2,$3,'historic-b','closed',23000,now())",[org.id,store,user]);
    const shiftColumns='id,organization_id,store_id,cashier_id,register_key,status,opening_cash,opened_at,closed_at,metadata';
    const shiftsBefore=(await db.query(`SELECT ${shiftColumns} FROM shifts WHERE organization_id=$1 ORDER BY id`,[org.id])).rows;
    const before=(await db.query(`SELECT ${legacyColumns} FROM organizations WHERE id=$1`,[org.id])).rows[0];
    await fs.copyFile(path.join(source,'033_subscription_billing.sql'),path.join(directory,'033_subscription_billing.sql'));
    const result=await runMigrations({pool:db,directory,logger:{}});assert.deepEqual(result.applied,['033_subscription_billing.sql']);
    assert.deepEqual((await db.query(`SELECT ${legacyColumns} FROM organizations WHERE id=$1`,[org.id])).rows[0],before);
    assert.deepEqual((await db.query('SELECT * FROM billing_payments WHERE id=$1',[payment.id])).rows[0],payment);
    assert.equal((await db.query('SELECT plan_code,legacy_expiry_date::text FROM organizations WHERE id=$1',[org.id])).rows[0].plan_code,null);
    assert.equal((await db.query('SELECT subscription_can_write($1) writable',[org.id])).rows[0].writable,true);
    await fs.copyFile(path.join(source,'034_resource_entitlements.sql'),path.join(directory,'034_resource_entitlements.sql'));
    assert.deepEqual((await runMigrations({pool:db,directory,logger:{}})).applied,['034_resource_entitlements.sql']);
    assert.deepEqual((await db.query(`SELECT ${shiftColumns} FROM shifts WHERE organization_id=$1 ORDER BY id`,[org.id])).rows,shiftsBefore);
    assert.equal((await db.query('SELECT count(*)::int n FROM shifts WHERE organization_id=$1 AND register_id IS NOT NULL',[org.id])).rows[0].n,2);
    assert.equal((await db.query('SELECT count(*)::int n FROM pos_registers WHERE organization_id=$1',[org.id])).rows[0].n,2);
    assert.deepEqual((await runMigrations({pool:db,directory,logger:{}})).applied,[]);
    const client=await db.connect();try{await client.query('BEGIN');await client.query(await fs.readFile(path.join(source,'034_resource_entitlements.sql'),'utf8'));await client.query('COMMIT');}finally{client.release()}
    await fs.copyFile(path.join(source,'035_zenix_ai.sql'),path.join(directory,'035_zenix_ai.sql'));
    assert.deepEqual((await runMigrations({pool:db,directory,logger:{}})).applied,['035_zenix_ai.sql']);
    assert.deepEqual((await db.query('SELECT * FROM billing_payments WHERE id=$1',[payment.id])).rows[0],payment);
    assert.deepEqual((await runMigrations({pool:db,directory,logger:{}})).applied,[]);
    await db.query(await fs.readFile(path.join(source,'035_zenix_ai.sql'),'utf8'));
    // Synthetic modern records for the subsequent offline backup/restore gate.
    await db.query("INSERT INTO subscription_terms(organization_id,payment_id,plan_code,pricing_version,billing_interval,starts_on,ends_on,value_amount) VALUES($1,$2,'BUSINESS',1,'ANNUAL','2026-02-01','2027-02-01',3300000)",[org.id,payment.id]);
    await db.query("INSERT INTO subscription_events(organization_id,payment_id,event_type,payload) VALUES($1,$2,'ACTIVATE','{}')",[org.id,payment.id]);
    await db.query("INSERT INTO ai_monthly_usage(organization_id,period_start,successes,input_tokens,output_tokens,spent_micros) VALUES($1,'2000-01-01',1,100,20,18)",[org.id]);
    await db.query("INSERT INTO ai_daily_budget(day,spent_micros) VALUES('2000-01-01',18)");
    await db.query("INSERT INTO ai_requests(organization_id,user_id,request_id,period_start,day,fingerprint,authorization_key,status,reserved_cost,actual_cost,response_expires_at,response) VALUES($1,$2,$3,'2000-01-01','2000-01-01','synthetic','synthetic','SUCCEEDED',2000,18,'2099-01-01','{}')",[org.id,user,randomUUID()]);
    await verifyDatabaseSchema(db);
    assert.deepEqual(await checkMigrationStatus({db,directory}),{tableMissing:false,missing:[],drifted:[],unverified:[],unknown:[]});
  }finally{await db.end();await fs.rm(directory,{recursive:true,force:true})}
});
