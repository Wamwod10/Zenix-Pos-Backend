import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.RESOURCE_TEST_DATABASE_URL;
test('capacity-only reads skip unlimited usage without weakening finite caps or detailed usage',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');
 const pool=new pg.Pool({connectionString:url}),db=await pool.connect();
 try{
  await db.query('BEGIN');
  assert.ok((await db.query("SELECT to_regprocedure('resource_entitlement(uuid,text,boolean)') AS f")).rows[0].f,'capacity-only overload must exist');
  const make=async plan=>(await db.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Capacity performance test',$1,'ACTIVE','2099-01-01') RETURNING id",[plan])).rows[0].id;
  const premium=await make('PREMIUM'),start=await make('START');
  await db.query("INSERT INTO products(organization_id,name) VALUES($1,'Test')",[premium]);
  const state=async(org,res,usage)=>(await db.query('SELECT resource_entitlement($1,$2,$3) AS state',[org,res,usage])).rows[0].state;
  for(const resource of ['employees','stores','warehouses','registers','products','customers']){
   for(const org of [premium,start]){
    const full=(await db.query('SELECT resource_entitlement($1,$2) AS state',[org,resource])).rows[0].state;
    assert.deepEqual(await state(org,resource,true),full);
    const capacity=await state(org,resource,false);
    assert.equal(capacity.limit,full.limit);
    if(full.limit===null)assert.equal(capacity.used,null);else assert.deepEqual(capacity,full);
   }
  }
  assert.equal((await state(premium,'products',true)).used,1);
  // A scheduled downgrade must replace the unlimited fast path on its due day.
  await db.query("UPDATE organizations SET subscription_pending_plan='START',subscription_change_on=CURRENT_DATE-1 WHERE id=$1",[premium]);
  assert.equal((await state(premium,'products',false)).limit,(await state(start,'products',true)).limit);
  assert.equal((await state(premium,'products',false)).used,1);
  await db.query('SAVEPOINT invalid_resource');
  await assert.rejects(()=>state(start,'unknown',false),e=>e.code==='ZX403');
  await db.query('ROLLBACK TO SAVEPOINT invalid_resource');
  await db.query('SAVEPOINT invalid_increase');
  await assert.rejects(()=>db.query("SELECT assert_resource_capacity($1,'products',0)",[start]),e=>e.code==='ZX403');
  await db.query('ROLLBACK TO SAVEPOINT invalid_increase');
 }finally{await db.query('ROLLBACK');db.release();await pool.end()}
});
