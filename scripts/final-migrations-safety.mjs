// Explicit disposable-database DDL benchmark; run only after the populated fixture.
import assert from 'node:assert/strict';
import pg from 'pg';
import {performance} from 'node:perf_hooks';
import {readFile} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
const target=assertSafeTestDatabaseUrl(url);
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55436');assert.equal(target.pathname,'/zenix_perf_test');
assert.ok(process.argv.includes('--exclusive-local-ddl'),'Coordinate an exclusive local DDL window first');
const pool=new pg.Pool({connectionString:url,max:4});
const db=await pool.connect(),writer=await pool.connect(),builder=await pool.connect();
const index='inventory_balances_org_product_store_idx';
const report={};let indexDropped=false;
const summary=values=>{const v=[...values].sort((a,b)=>a-b);return {n:v.length,p50:v[Math.ceil(v.length*.5)-1],p95:v[Math.ceil(v.length*.95)-1],samples:values}};
const migration=await readFile(new URL('../migrations/039_inventory_catalog_lookup_index.sql',import.meta.url),'utf8');
const createIndex=()=>builder.query(migration.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean).find(s=>s.startsWith('CREATE INDEX')));
try{
 report.indexes=(await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='inventory_balances' ORDER BY indexname")).rows;
 report.functions=(await db.query("SELECT oid::regprocedure::text signature,prosecdef,proconfig,proacl FROM pg_proc WHERE proname IN ('resource_entitlement','assert_resource_capacity') ORDER BY 1")).rows;
 assert.ok(report.functions.every(f=>!f.prosecdef),'Capacity functions must remain SECURITY INVOKER');
 await db.query('BEGIN');
 const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,plan_code) VALUES('Final migration safety fixture','ACTIVE','2099-01-01','BUSINESS') RETURNING id")).rows[0].id;
 const entitlement=async(resource,usage=true)=>(await db.query('SELECT resource_entitlement($1,$2,$3) e',[org,resource,usage])).rows[0].e;
 assert.equal((await entitlement('products',false)).limit,10000);
 assert.equal((await entitlement('products',false)).used,0);
 await db.query("SELECT assert_resource_capacity($1,'products',10000)",[org]);
 await db.query('SAVEPOINT capacity_limit');
 await assert.rejects(db.query("SELECT assert_resource_capacity($1,'products',10001)",[org]),e=>e.code==='ZX409');
 await db.query('ROLLBACK TO SAVEPOINT capacity_limit');
 assert.equal((await entitlement('customers',false)).used,null);
 assert.equal((await entitlement('customers')).used,0);
 await db.query("UPDATE organizations SET plan_code='PREMIUM' WHERE id=$1",[org]);
 assert.equal((await entitlement('products',false)).limit,null);
 assert.equal((await entitlement('products',false)).used,null);
 assert.equal((await entitlement('products')).used,0);
 await db.query("UPDATE organizations SET subscription_pending_plan='START',subscription_change_on=(clock_timestamp() AT TIME ZONE 'Asia/Tashkent')::date WHERE id=$1",[org]);
 assert.equal((await entitlement('products',false)).planCode,'START');
 assert.equal((await entitlement('products',false)).limit,750);
 await db.query('SAVEPOINT downgrade_limit');
 await assert.rejects(db.query("SELECT assert_resource_capacity($1,'products',751)",[org]),e=>e.code==='ZX409');
 await db.query('ROLLBACK TO SAVEPOINT downgrade_limit');
 report.entitlements='BUSINESS finite products and unlimited customers; PREMIUM unlimited products; public usage; due START downgrade enforced';
 await db.query('CREATE ROLE final_migration_invoker_probe NOLOGIN');
 await db.query('SAVEPOINT invoker_permissions');
 await db.query('SET LOCAL ROLE final_migration_invoker_probe');
 await assert.rejects(db.query("SELECT resource_entitlement($1,'products',false)",[org]),e=>e.code==='42501');
 await db.query('ROLLBACK TO SAVEPOINT invoker_permissions');
 report.unprivilegedRole='42501: public EXECUTE cannot bypass underlying table permissions';
 await db.query('ROLLBACK');
 // Exercise the documented 038 rollback and reapply, atomically and locally.
 const original=await readFile(new URL('../migrations/034_resource_entitlements.sql',import.meta.url),'utf8');
 const definitions=original.slice(original.indexOf('CREATE OR REPLACE FUNCTION resource_entitlement('),original.indexOf('CREATE OR REPLACE FUNCTION guard_resource_capacity('));
 await db.query('BEGIN');await db.query(definitions);
 await db.query('DROP FUNCTION resource_entitlement(uuid,text,boolean)');
 assert.equal((await db.query("SELECT to_regprocedure('resource_entitlement(uuid,text,boolean)') f")).rows[0].f,null);
 await db.query(await readFile(new URL('../migrations/038_resource_capacity_performance.sql',import.meta.url),'utf8'));
 assert.ok((await db.query("SELECT to_regprocedure('resource_entitlement(uuid,text,boolean)') f")).rows[0].f);
 await db.query('ROLLBACK');report.capacityRollbackReapply='passed atomically; original applied state retained';
 const fixture=(await db.query("SELECT organization_id,count(*)::int n FROM inventory_balances GROUP BY organization_id HAVING count(*)>=100000 ORDER BY count(*) DESC LIMIT 1")).rows[0];
 assert.ok(fixture,'Requires at least 100000 real inventory_balances rows');report.populatedRows=fixture.n;
 // Reuse existing product/store keys in rollback-only delete + reinsert samples.
 // Financial quantities are preserved and never committed.
 const ids=(await db.query('SELECT store_id,product_id FROM inventory_balances WHERE organization_id=$1 ORDER BY store_id,product_id LIMIT 500',[fixture.organization_id])).rows;
 const stores=ids.map(r=>r.store_id),products=ids.map(r=>r.product_id);
 const sample=async()=>{
  const times=[];
  for(let i=0;i<12;i++){
   await db.query('BEGIN');
   try{
    await db.query('CREATE TEMP TABLE final_migration_write_rows ON COMMIT DROP AS SELECT b.* FROM inventory_balances b JOIN unnest($1::uuid[],$2::uuid[]) k(store_id,product_id) USING(store_id,product_id)',[stores,products]);
    await db.query('DELETE FROM inventory_balances b USING final_migration_write_rows k WHERE b.store_id=k.store_id AND b.product_id=k.product_id');
    const start=performance.now();
    await db.query('INSERT INTO inventory_balances SELECT * FROM final_migration_write_rows');
    if(i>=2)times.push(performance.now()-start);
   }finally{await db.query('ROLLBACK')}
  }return summary(times);
 };
 await builder.query('SET lock_timeout=\'5s\'');
 await builder.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);indexDropped=true;
 report.insert500WithoutIndex=await sample();
 // A writer already in flight must delay concurrent build, without blocking
 // independent row writes. Observe the actual lock, not a guessed sleep.
 await writer.query('BEGIN');
 await writer.query('UPDATE inventory_balances SET version=version WHERE store_id=$1 AND product_id=$2',[stores[0],products[0]]);
 const pid=(await builder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const started=performance.now();let buildError;
 const build=createIndex().catch(e=>{buildError=e});
 let waiting=false;
 for(let i=0;i<200;i++){
  const state=(await db.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
  if(state?.wait_event_type==='Lock'){waiting=true;report.buildWait=state;break}
  await new Promise(r=>setTimeout(r,10));
 }
 assert.ok(waiting,'Concurrent index must wait for held writer');
 await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='2s'");
 const writeOrg=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,plan_code) VALUES('Concurrent migration writer','ACTIVE','2099-01-01','PREMIUM') RETURNING id")).rows[0].id;
 const writeStore=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Concurrent migration store') RETURNING id",[writeOrg])).rows[0].id;
 const writeProduct=(await db.query("INSERT INTO products(organization_id,name) VALUES($1,'Concurrent migration product') RETURNING id",[writeOrg])).rows[0].id;
 const writeStart=performance.now();
 await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,0)',[writeOrg,writeStore,writeProduct]);
 report.writeDuringBuildMs=performance.now()-writeStart;
 await db.query('ROLLBACK');await writer.query('ROLLBACK');await build;
 if(buildError)throw buildError;indexDropped=false;report.concurrentBuildMs=performance.now()-started;
 report.insert500WithIndex=await sample();
 report.indexSizeBytes=Number((await db.query('SELECT pg_relation_size($1::regclass) bytes',[index])).rows[0].bytes);
 const state=(await db.query('SELECT indisvalid,indisready FROM pg_index WHERE indexrelid=$1::regclass',[index])).rows[0];
 assert.deepEqual(state,{indisvalid:true,indisready:true});report.finalIndexState=state;
 report.finalPopulatedRows=Number((await db.query('SELECT count(*) n FROM inventory_balances WHERE organization_id=$1',[fixture.organization_id])).rows[0].n);
 assert.equal(report.finalPopulatedRows,fixture.n);
 console.log(JSON.stringify(report,null,2));
}finally{
 await Promise.allSettled([db.query('ROLLBACK'),writer.query('ROLLBACK')]);
 if(indexDropped){await builder.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`);await createIndex()}
 db.release();writer.release();builder.release();await pool.end();
}
