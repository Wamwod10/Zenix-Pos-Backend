import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
test('catalog balance index leads with tenant and product without changing branch values',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');
 const pool=new pg.Pool({connectionString:url}),db=await pool.connect();
 try{
  await db.query('BEGIN');
  const index=(await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='inventory_balances_org_product_store_idx'")).rows[0];
  assert.ok(index,'measured catalog lookup index must exist');
  assert.match(index.indexdef,/\(organization_id, product_id, store_id\)/);
  const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES('Index test','ACTIVE','2099-01-01',2) RETURNING id")).rows[0].id;
  const stores=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'A'),($1,'B') RETURNING id",[org])).rows;
  const product=(await db.query("INSERT INTO products(organization_id,name) VALUES($1,'Test') RETURNING id",[org])).rows[0].id;
  await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,100),($1,$4,$3,50)',[org,stores[0].id,product,stores[1].id]);
  const stock=(await db.query('SELECT jsonb_object_agg(store_id,quantity) stock FROM inventory_balances WHERE organization_id=$1 AND product_id=$2',[org,product])).rows[0].stock;
  assert.equal(Number(stock[stores[0].id]),100);assert.equal(Number(stock[stores[1].id]),50);
  assert.equal((await db.query('SELECT quantity FROM inventory_balances WHERE organization_id=$1 AND product_id=$2 AND store_id=$3',[org,product,stores[0].id])).rows.length,1);
 }finally{await db.query('ROLLBACK');db.release();await pool.end()}
});
