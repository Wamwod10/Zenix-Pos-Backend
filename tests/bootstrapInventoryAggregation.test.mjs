import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
test('actual bootstrap aggregation preserves owner and locked-branch product snapshots',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');
 const [{pool},{default:router}]=await Promise.all([import('../src/db/pool.js'),import('../src/routes/bootstrap.js')]);
 const db=await pool.connect(),original=pool.query;
 const handler=router.stack.find(layer=>layer.route?.path==='/'&&layer.route.methods.get).route.stack.at(-1).handle;
 try{
  await db.query('BEGIN');
  const org=(await db.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Bootstrap aggregate regression','PREMIUM','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  const stores=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'A'),($1,'B') RETURNING id",[org])).rows.map(r=>r.id);
  const products=(await db.query("INSERT INTO products(organization_id,name,metadata) VALUES($1,'No balance','{}'),($1,'Decimal tracked','{\"custom\":\"retained\"}') RETURNING id",[org])).rows.map(r=>r.id);
  await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,1.250),($1,$4,$3,0)',[org,stores[0],products[1],stores[1]]);
  const other=(await db.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Other tenant','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO products(organization_id,name) VALUES($1,'Must not appear')",[other]);
  const expected=async branch=>(await db.query(`SELECT p.id,p.metadata,COALESCE(jsonb_object_agg(b.store_id,b.quantity) FILTER(WHERE b.store_id IS NOT NULL),'{}'::jsonb) stock
    FROM products p LEFT JOIN inventory_balances b ON b.organization_id=p.organization_id AND b.product_id=p.id ${branch?'AND b.store_id=$2':''}
    WHERE p.organization_id=$1 GROUP BY p.id`,branch?[org,branch]:[org])).rows;
  for(const branch of [null,...stores]){
   const baseline=await expected(branch);let body,failure;
   pool.query=(...args)=>db.query(...args);
   await handler({get:()=>undefined,user:{organizationId:org,appRole:branch?'CASHIER':'OWNER',storeId:branch,permissionOverrides:{moduleProducts:true,moduleInventory:true},rolePermissions:{}},acceptsEncodings:()=>false},{vary(){return this},status(){return this},json(value){body=JSON.parse(JSON.stringify(value));return this}},error=>{failure=error});
   pool.query=original;assert.ifError(failure);assert.equal(body.data.inventory.length,2);
   for(const item of body.data.inventory){const old=baseline.find(p=>p.id===item.id);assert.ok(old);assert.deepEqual(item.stockByStore,old.stock);assert.deepEqual(item.metadata,old.metadata);assert.equal(item.lastSaleAt,null);}
  }

  let coreBody,failure;const queried=[];
  pool.query=(sql,...args)=>{queried.push(sql);return db.query(sql,...args)};
  await handler({get:()=> 'core',user:{organizationId:org,appRole:'OWNER'},acceptsEncodings:()=>false},{vary(){return this},status(){return this},json(value){coreBody=value;return this}},error=>{failure=error});
  pool.query=original;assert.ifError(failure);assert.deepEqual(coreBody.data.inventory,[]);assert.deepEqual(coreBody.data.catalog,{complete:false,mode:'remote-v1'});
  assert.equal(queried.some(sql=>/FROM products p|FROM product_serials ps|FROM inventory_batches ib/.test(sql)),false,'core skips product and tracking queries');
 }finally{pool.query=original;await db.query('ROLLBACK');db.release();await pool.end();}
});
