// Synthetic rollback-only benchmark; never accepts production/remote targets.
import pg from 'pg';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
const pool=new pg.Pool({connectionString:url,max:1}),db=await pool.connect(),results=[];
const summary=values=>{values.sort((a,b)=>a-b);return {samples:values.length,p50:values[Math.ceil(values.length*.5)-1],p95:values[Math.ceil(values.length*.95)-1],p99:values[Math.ceil(values.length*.99)-1]}};
try{
 await db.query('BEGIN');
 // Existing legacy tier permits bulk fixture creation; no trigger is disabled.
 const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Synthetic capacity fixture','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
 let previous=0;
 for(const size of [1000,10000,50000]){
  await db.query('UPDATE organizations SET plan_code=NULL WHERE id=$1',[org]);
  await db.query("INSERT INTO products(organization_id,name) SELECT $1,'Fixture '||n FROM generate_series($2::int,$3::int) n",[org,previous+1,size]);
  previous=size;
  await db.query("UPDATE organizations SET plan_code='PREMIUM' WHERE id=$1",[org]);
  const samples=[];
  for(let i=0;i<55;i++){
   const started=performance.now();await db.query("SELECT assert_resource_capacity($1,'products',1)",[org]);
   if(i>=5)samples.push(performance.now()-started);
  }
  const imports=[];
  for(let i=0;i<10;i++){
   await db.query('SAVEPOINT import_sample');
   const started=performance.now();
   await db.query("INSERT INTO products(organization_id,name) SELECT $1,'Import '||n FROM generate_series(1,100) n",[org]);
   imports.push(performance.now()-started);await db.query('ROLLBACK TO SAVEPOINT import_sample');
  }
  results.push({products:size,capacity:summary(samples),import100:summary(imports)});
 }
 const optimized=Boolean((await db.query("SELECT to_regprocedure('resource_entitlement(uuid,text,boolean)') AS f")).rows[0].f);
 const result={mode:optimized?'optimized':'baseline',results};
 await mkdir('.cache/performance',{recursive:true});
 await writeFile(`.cache/performance/capacity-${result.mode}.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{await db.query('ROLLBACK');db.release();await pool.end()}
