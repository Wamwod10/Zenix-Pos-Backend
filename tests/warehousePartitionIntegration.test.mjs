import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {setInventoryWarehouse} from '../src/services/warehouses.js';
const url=process.env.TEST_DATABASE_URL;
(url?test:test.skip)('warehouse migration partitions branch stock, scopes receipts and rolls back sale debits',{timeout:30000},async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV||'test'});
 const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000,options:'-c lock_timeout=5s -c statement_timeout=20s'});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const schema='warehouse_test_'+randomUUID().replaceAll('-','');
  await db.query('CREATE SCHEMA '+schema);await db.query('SET LOCAL search_path TO '+schema+',public');
  await db.query('CREATE TABLE stores(id uuid PRIMARY KEY,organization_id uuid NOT NULL,UNIQUE(organization_id,id)); CREATE TABLE products(id uuid PRIMARY KEY,organization_id uuid NOT NULL,UNIQUE(organization_id,id)); CREATE TABLE inventory_balances(organization_id uuid NOT NULL,store_id uuid NOT NULL,product_id uuid NOT NULL,quantity numeric(18,3) NOT NULL,PRIMARY KEY(organization_id,store_id,product_id)); CREATE TABLE inventory_batches(id uuid PRIMARY KEY,expiry_date date)');
  const org=randomUUID(),foreignOrg=randomUUID(),store=randomUUID(),other=randomUUID(),product=randomUUID();
  await db.query('INSERT INTO stores VALUES($1,$2)',[store,org]);await db.query('INSERT INTO products VALUES($1,$2)',[product,org]);await db.query('INSERT INTO inventory_balances VALUES($1,$2,$3,10)',[org,store,product]);
  await db.query(readFileSync(new URL('../migrations/031_branch_warehouses.sql',import.meta.url),'utf8'));
  const main=(await db.query('SELECT id FROM warehouses WHERE organization_id=$1 AND store_id=$2 AND is_default',[org,store])).rows[0].id;
  const sums=async()=>{const result=await db.query('SELECT b.quantity,COALESCE(sum(w.quantity),0) partition FROM inventory_balances b LEFT JOIN warehouse_balances w USING(organization_id,store_id,product_id) WHERE b.organization_id=$1 AND b.store_id=$2 AND b.product_id=$3 GROUP BY b.quantity',[org,store,product]);assert.equal(Number(result.rows[0].quantity),Number(result.rows[0].partition));return Number(result.rows[0].quantity);};
  assert.equal(await sums(),10);
  await db.query('INSERT INTO stores VALUES($1,$2)',[other,foreignOrg]);assert.equal((await db.query('SELECT count(*)::int count FROM warehouses WHERE store_id=$1 AND is_default',[other])).rows[0].count,1);
  const extra=(await db.query("INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,'Second') RETURNING id",[org,store])).rows[0].id;
  const update=async delta=>{await db.query('SELECT quantity FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 FOR UPDATE',[org,store,product]);await db.query('UPDATE inventory_balances SET quantity=quantity+$4 WHERE organization_id=$1 AND store_id=$2 AND product_id=$3',[org,store,product,delta]);};
  await setInventoryWarehouse(db,{organizationId:org,storeId:store,warehouseId:extra});await update(7);assert.equal(await sums(),17);assert.equal(Number((await db.query('SELECT quantity FROM warehouse_balances WHERE warehouse_id=$1 AND product_id=$2',[extra,product])).rows[0].quantity),7);
  await db.query("SELECT set_config('zenix.inventory_warehouse','',true)");await db.query('SAVEPOINT sale');await update(-12);assert.equal(await sums(),5);assert.equal(Number((await db.query('SELECT quantity FROM warehouse_balances WHERE warehouse_id=$1 AND product_id=$2',[main,product])).rows[0].quantity),0);assert.equal(Number((await db.query('SELECT quantity FROM warehouse_balances WHERE warehouse_id=$1 AND product_id=$2',[extra,product])).rows[0].quantity),5);
  await db.query('ROLLBACK TO SAVEPOINT sale');assert.equal(await sums(),17);
  await assert.rejects(()=>setInventoryWarehouse(db,{organizationId:foreignOrg,storeId:other,warehouseId:extra}),error=>error.code==='WAREHOUSE_NOT_FOUND');
  await db.query('SAVEPOINT bad_scope');await db.query("SELECT set_config('zenix.inventory_warehouse',$1,true)",[(await db.query('SELECT id FROM warehouses WHERE store_id=$1',[other])).rows[0].id]);await assert.rejects(()=>update(1),error=>error.code==='23514');await db.query('ROLLBACK TO SAVEPOINT bad_scope');assert.equal(await sums(),17);
  await update(-20);assert.equal(await sums(),-3);
 }finally{await db.query('ROLLBACK');db.release();await pool.end();}
});
