import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {receiveInventory,inventoryReceiptSchema} from '../src/services/inventoryReceipt.js';
import {readPosCatalog} from '../src/services/posCatalog.js';

const url=process.env.TEST_DATABASE_URL;
test('two branch costs survive a zero-cost opening receipt and catalog projection',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);
 const db=new pg.Client({connectionString:url});await db.connect();
 try{
  await db.query('BEGIN');
  const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Branch costing fixture','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  const stores=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Zero cost branch'),($1,'Other branch') RETURNING id",[org])).rows.map(r=>r.id);
  const userId=(await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Cost owner',$2,'unused','OWNER') RETURNING id",[org,randomUUID()])).rows[0].id;
  const product=(await db.query("INSERT INTO products(organization_id,name,sku,cost_price,sell_price) VALUES($1,'Branch cost product',$2,99,200) RETURNING id",[org,randomUUID()])).rows[0].id;
  await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$4,10,0),($1,$3,$4,20,15)',[org,...stores,product]);
  const user={id:userId,organizationId:org,appRole:'OWNER'};
  const before=await readPosCatalog(db,user,{storeId:stores[0]});assert.equal(before.products[0].costByStore[stores[0]],0);
  const input=inventoryReceiptSchema.parse({storeId:stores[0],clientReference:randomUUID(),lines:[{productId:product,quantity:10,costPrice:20}]});
  await receiveInventory(db,user,input);
  const rows=(await db.query('SELECT store_id,quantity,avg_cost FROM inventory_balances WHERE organization_id=$1 AND product_id=$2',[org,product])).rows;
  assert.equal(Number(rows.find(r=>r.store_id===stores[0]).avg_cost),10);
  assert.equal(Number(rows.find(r=>r.store_id===stores[1]).avg_cost),15);
  assert.equal(Number(rows.find(r=>r.store_id===stores[0]).quantity),20);
  for(const [index,cost] of [[0,10],[1,15]]){
   const catalog=await readPosCatalog(db,user,{storeId:stores[index]});
   assert.equal(catalog.products[0].costByStore[stores[index]],cost);
   assert.deepEqual(Object.keys(catalog.products[0].costByStore),[stores[index]]);
  }
 }finally{await db.query('ROLLBACK');await db.end()}
});
