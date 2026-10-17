import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {readPosCatalog} from '../src/services/posCatalog.js';
const url=process.env.TEST_DATABASE_URL;
test('actual POS catalog scopes tenant/store, preserves microseconds and archived restore',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');
 const {pool}=await import('../src/db/pool.js');const db=await pool.connect();
 try{
 await db.query('BEGIN');
 const org=(await db.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('POS catalog test','PREMIUM','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
 const otherOrg=(await db.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Other POS tenant','PREMIUM','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
 const stores=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'A'),($1,'B') RETURNING id",[org])).rows.map(r=>r.id);
 const otherStore=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Other') RETURNING id",[otherOrg])).rows[0].id;
 const productIds=[];
 for(const [name,time,archived,category,barcode] of [['First','2026-10-17T10:00:00.123457Z',false,'Hidden page','first'],['Second','2026-10-17T10:00:00.123456Z',false,'Food','second'],['Old','2026-10-17T10:00:00Z',true,'Old','archived']]){
 productIds.push((await db.query('INSERT INTO products(organization_id,name,created_at,archived,category,barcode,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[org,name,time,archived,category,barcode,{variants:[{name:'Red'}],stockBatches:['stale'],serializedUnits:['stale']}])).rows[0].id);
 }
 await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,1.25),($1,$4,$3,99)',[org,stores[0],productIds[0],stores[1]]);
 await db.query("INSERT INTO product_serials(organization_id,store_id,product_id,serial) VALUES($1,$2,$3,'HERE'),($1,$4,$3,'OTHER')",[org,stores[0],productIds[0],stores[1]]);
 await db.query("INSERT INTO inventory_batches(organization_id,store_id,product_id,received_quantity,remaining_quantity,unit_cost) VALUES($1,$2,$3,3,2,4.5),($1,$4,$3,10,10,99)",[org,stores[0],productIds[0],stores[1]]);
 const user={organizationId:org,appRole:'CASHIER',storeId:stores[0]};
 const first=await readPosCatalog(db,user,{storeId:stores[0],limit:1});
 assert.equal(first.products[0].id,productIds[0]);assert.equal(first.hasMore,true);assert.deepEqual(first.categories,['Food','Hidden page']);assert.deepEqual(first.products[0].stockByStore,{[stores[0]]:1.25});assert.equal(first.products[0].stockBatches.length,1);assert.equal(first.products[0].stockBatches[0].storeId,stores[0]);assert.equal(first.products[0].stockBatches[0].costPrice,4.5);assert.deepEqual(first.products[0].serializedUnits.map(unit=>unit.serial),['HERE']);
 const second=await readPosCatalog(db,user,{storeId:stores[0],limit:1,cursor:first.nextCursor});
 assert.equal(second.products[0].id,productIds[1]);assert.equal(second.hasMore,false);assert.deepEqual(second.products[0].stockByStore,{[stores[0]]:0});
 const ids=await readPosCatalog(db,user,{storeId:stores[0],ids:`${productIds[2]},${otherStore}`,limit:1});
 assert.equal(ids.products[0].archived,true);assert.deepEqual(ids.missingIds,[otherStore]);
 assert.equal((await readPosCatalog(db,user,{storeId:stores[0],barcode:'archived'})).products.length,0);
 assert.equal((await readPosCatalog(db,user,{storeId:stores[0],barcode:'first'})).products[0].id,productIds[0]);
 await assert.rejects(readPosCatalog(db,user,{storeId:stores[1]}),{code:'STORE_FORBIDDEN'});
 await assert.rejects(readPosCatalog(db,{organizationId:org,appRole:'OWNER'},{storeId:otherStore}),{code:'STORE_NOT_FOUND'});
 }finally{await db.query('ROLLBACK');db.release();await pool.end()}
});
