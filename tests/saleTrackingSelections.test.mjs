import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../src/services/saleTrackingSelections.js').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
const plan=(client,input)=>{assert.equal(typeof module.planSaleTracking,'function','sale tracking requires authoritative selection planning');return module.planSaleTracking(client,input);};
const scope={organizationId:'org',storeId:'store',productId:'product',quantity:1,stock:2};
const serials=[{id:'first',serial:'FIRST',status:'IN_STOCK'},{id:'chosen',serial:'CHOSEN',status:'IN_STOCK'}];
const batches=[{id:'early',remaining_quantity:1,batch_no:'EARLY',expiry_date:'2026-10-10',created_at:'2026-10-01'},{id:'chosen-b',remaining_quantity:1,batch_no:'CHOSEN-B',expiry_date:'2026-11-10',created_at:'2026-10-01'}];
function clientFor(units=serials,lots=batches){const scoped=rows=>rows.map(row=>({organization_id:'org',store_id:'store',product_id:'product',...row}));return {calls:[],query:async function(sql,args){this.calls.push({sql,args});if(sql.includes('SELECT')&&sql.includes('product_serials'))return {rows:scoped(units),rowCount:units.length};if(sql.includes('SELECT')&&sql.includes('inventory_batches'))return {rows:scoped(lots),rowCount:lots.length};if(sql.includes('UPDATE'))return {rowCount:1};throw Error('Unexpected query');}};}
test('sale locks scoped tracking and consumes exact selected IDs rather than first/FEFO records',async()=>{
 const client=clientFor();
 const result=await plan(client,{...scope,metadata:{tracking:{serials:[{id:'chosen',serial:'CHOSEN'}],batches:[{batchId:'chosen-b',quantity:1}]}}});
 assert.deepEqual(result.serials.map(row=>[row.id,row.serial]),[['chosen','CHOSEN']]);
 assert.deepEqual(result.batches.map(row=>[row.batchId,row.quantity]),[['chosen-b',1]]);
 assert.deepEqual(client.calls.map(call=>call.args),[['org','store','product'],['org','store','product']]);
 assert.ok(client.calls.every(call=>/ORDER BY id.*FOR UPDATE/s.test(call.sql)));
 await module.consumeSaleTracking(client,{...scope,tracking:result,saleId:'sale'});
 const updates=client.calls.filter(call=>call.sql.includes('UPDATE')&&!call.sql.includes('SELECT'));
 assert.equal(updates.length,2);
 assert.ok(updates.some(call=>call.args.includes('chosen')));assert.ok(updates.some(call=>call.args.includes('chosen-b')));
 assert.ok(updates.every(call=>call.args.includes('org')&&call.args.includes('store')&&call.args.includes('product')));
});
test('no explicit selections preserve automatic serial and FEFO batch allocation',async()=>{
 const result=await plan(clientFor(),scope);
 assert.deepEqual(result.serials.map(row=>row.id),['first']);
 assert.deepEqual(result.batches.map(row=>row.batchId),['early']);
});
test('explicit serial IDs/values reject stale, mismatched, duplicated and wrong quantity selections',async()=>{
 for(const [entries,code] of [[[{id:'outside-scope'}],'SERIAL_NOT_AVAILABLE'],[[{id:'chosen',serial:'FIRST'}],'SERIAL_NOT_AVAILABLE'],[[{id:'chosen'},{serial:'CHOSEN'}],'DUPLICATE_SERIAL'],[[{id:'chosen'},{id:'first'}],'SERIAL_QUANTITY_MISMATCH']]){
  await assert.rejects(async()=>plan(clientFor(),{...scope,metadata:{tracking:{serials:entries}}}),error=>error.code===code);
 }
 await assert.rejects(async()=>plan(clientFor([{id:'chosen',serial:'CHOSEN',status:'SOLD'}]),{...scope,metadata:{tracking:{serials:[{id:'chosen'}]}}}),error=>error.code==='SERIAL_NOT_AVAILABLE');
});
test('explicit batches reject unavailable, duplicate and incomplete allocations with stable codes',async()=>{
 for(const [entries,code] of [[[{batchId:'outside-scope',quantity:1}],'BATCH_NOT_AVAILABLE'],[[{batchId:'chosen-b',quantity:2}],'BATCH_NOT_AVAILABLE'],[[{batchId:'chosen-b',quantity:0.5},{batchId:'chosen-b',quantity:0.5}],'DUPLICATE_BATCH'],[[{batchId:'chosen-b',quantity:0.5}],'BATCH_QUANTITY_MISMATCH']]){
  await assert.rejects(async()=>plan(clientFor(),{...scope,metadata:{tracking:{batches:entries}}}),error=>error.code===code);
 }
});
test('consumption fails closed if a locked selection cannot be updated',async()=>{
 const client=clientFor();const tracking=await plan(client,scope);
 client.query=async()=>({rowCount:0});
 await assert.rejects(()=>module.consumeSaleTracking(client,{...scope,tracking,saleId:'sale'}),error=>error.code==='SERIAL_NOT_AVAILABLE');
});

test('PostgreSQL consumes only selected units and rejects stale or cross-store selections', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
 const {assertSafeTestDatabaseUrl}=await import('../scripts/assertTestDatabase.js');
 assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
 assert.equal(process.env.NODE_ENV,'test');
 assert.equal(process.env.DATABASE_URL,process.env.TEST_DATABASE_URL);
 const {default:pg}=await import('pg');
 const {runMigrations}=await import('../src/db/migrationRunner.js');
 const {fileURLToPath}=await import('node:url');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,connectionTimeoutMillis:5000});
 let client;
 try{
  await runMigrations({pool,directory:fileURLToPath(new URL('../migrations/',import.meta.url)),logger:{log(){},info(){}},lockTimeoutMs:5000});
  client=await pool.connect();await client.query('BEGIN');
  const organizationId=(await client.query("INSERT INTO organizations(name) VALUES('Task 7 tracking test') RETURNING id")).rows[0].id;
  const storeId=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'Selected units') RETURNING id",[organizationId])).rows[0].id;
  const otherStoreId=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'Outside scope') RETURNING id",[organizationId])).rows[0].id;
  const productId=(await client.query("INSERT INTO products(organization_id,name) VALUES($1,'Tracked product') RETURNING id",[organizationId])).rows[0].id;
  const unit=async(store,serial)=>(await client.query('INSERT INTO product_serials(organization_id,store_id,product_id,serial) VALUES($1,$2,$3,$4) RETURNING id',[organizationId,store,productId,serial])).rows[0].id;
  const first=await unit(storeId,'FIRST');const chosen=await unit(storeId,'CHOSEN');const outside=await unit(otherStoreId,'OUTSIDE');
  const batch=async(store,label,expiry)=>(await client.query('INSERT INTO inventory_batches(organization_id,store_id,product_id,batch_no,expiry_date,received_quantity,remaining_quantity) VALUES($1,$2,$3,$4,$5,1,1) RETURNING id',[organizationId,store,productId,label,expiry])).rows[0].id;
  const early=await batch(storeId,'EARLY','2026-10-10');const chosenBatch=await batch(storeId,'CHOSEN','2026-11-10');const outsideBatch=await batch(otherStoreId,'OUTSIDE','2026-12-10');
  const input={organizationId,storeId,productId,quantity:1,stock:2};
  for(const [metadata,code] of [
   [{tracking:{serials:[{id:outside}]}},'SERIAL_NOT_AVAILABLE'],
   [{tracking:{serials:[{id:chosen,serial:'FIRST'}]}},'SERIAL_NOT_AVAILABLE'],
   [{tracking:{serials:[{id:chosen},{serial:'CHOSEN'}]}},'DUPLICATE_SERIAL'],
   [{tracking:{batches:[{batchId:outsideBatch,quantity:1}]}},'BATCH_NOT_AVAILABLE'],
   [{tracking:{batches:[{batchId:chosenBatch,quantity:0.5}]}},'BATCH_QUANTITY_MISMATCH'],
  ])await assert.rejects(()=>plan(client,{...input,metadata}),error=>error.code===code);
  const tracking=await plan(client,{...input,metadata:{tracking:{serials:[{id:chosen,serial:'CHOSEN'}],batches:[{batchId:chosenBatch,quantity:1}]}}});
  const saleId=(await client.query("INSERT INTO sales(organization_id,store_id,sale_number) VALUES($1,$2,'TASK7-SELECTED') RETURNING id",[organizationId,storeId])).rows[0].id;
  await module.consumeSaleTracking(client,{...input,saleId,tracking});
  const unitRows=(await client.query('SELECT id,status FROM product_serials WHERE id=ANY($1::uuid[])',[ [first,chosen,outside] ])).rows;
  assert.equal(unitRows.find(row=>row.id===chosen).status,'SOLD');
  assert.equal(unitRows.find(row=>row.id===first).status,'IN_STOCK');
  assert.equal(unitRows.find(row=>row.id===outside).status,'IN_STOCK');
  const batchRows=(await client.query('SELECT id,remaining_quantity FROM inventory_batches WHERE id=ANY($1::uuid[])',[[early,chosenBatch,outsideBatch]])).rows;
  assert.equal(Number(batchRows.find(row=>row.id===chosenBatch).remaining_quantity),0);
  assert.equal(Number(batchRows.find(row=>row.id===early).remaining_quantity),1);
  assert.equal(Number(batchRows.find(row=>row.id===outsideBatch).remaining_quantity),1);
  await assert.rejects(()=>plan(client,{...input,metadata:{tracking:{serials:[{id:chosen}]}}}),error=>error.code==='SERIAL_NOT_AVAILABLE');
  await assert.rejects(()=>plan(client,{...input,metadata:{tracking:{batches:[{batchId:chosenBatch,quantity:1}]}}}),error=>error.code==='BATCH_NOT_AVAILABLE');
 }finally{if(client){await client.query('ROLLBACK');client.release();}await pool.end();}
});
