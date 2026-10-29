import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
test('transfer receiving enforces exact quantity precision and branch/tenant boundaries',{skip:!url,timeout:30000},async()=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
 const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const post=async(path,token,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/inventory${path}`,{method:'POST',headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:`zenix_session=${token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return {status:response.status,...await response.json()}};
 const expectStatus=(result,status)=>{assert.equal(result.status,status,JSON.stringify(result));return result.data};
 const session=async(org,store,role)=>{const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Transfer test',$3,'unused',$4) RETURNING id",[org,store,randomUUID(),role])).rows[0].id;const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);return token};
 try{
  const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES('Transfer precision','ACTIVE',CURRENT_DATE+30,2) RETURNING id")).rows[0].id;
  const stores=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Source'),($1,'Destination') RETURNING id",[org])).rows.map(row=>row.id);const owner=await session(org,stores[0],'OWNER'),sourceWorker=await session(org,stores[0],'WAREHOUSE');
  const product=(await pool.query("INSERT INTO products(organization_id,name,unit) VALUES($1,'Kilograms','kg') RETURNING id",[org])).rows[0].id;
  await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,10,2)',[org,stores[0],product]);
  // Invalid quantities must fail before any transfer/adjustment can affect stock.
  for(const quantity of ['',null,0,0.0001,'0.0001',1.0000000001,1000000000]){
   expectStatus(await post('/transfers',owner,{fromStoreId:stores[0],toStoreId:stores[1],needsApproval:false,items:[{productId:product,quantity}]}),400);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM stock_transfers WHERE organization_id=$1',[org])).rows[0].n,0);
  }
  for(const delta of ['',null,0,0.0001,-0.0001,1.0000000001,1000000000]){
   expectStatus(await post('/adjust',owner,{storeId:stores[0],productId:product,delta,reason:'Invalid raw inventory delta'}),400);
   assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0],product])).rows[0].quantity),10);
  }
  const adjust=await post('/adjust',owner,{storeId:stores[0],productId:product,delta:'-0.125',reason:'Measured stock correction'});
  expectStatus(adjust,200);
  assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0],product])).rows[0].quantity),9.875);
  expectStatus(await post('/adjust',owner,{storeId:stores[0],productId:product,delta:'0.125',reason:'Reversed correction'}),200);
  assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0],product])).rows[0].quantity),10);
  // Fractional reservation must use PostgreSQL NUMERIC(18,3) arithmetic.
  // Previously 0.300 - 0.200 became 0.09999999999999998, rejecting 0.100.
  const reservedProduct=(await pool.query("INSERT INTO products(organization_id,name,unit) VALUES($1,'Fractional reserved stock','kg') RETURNING id",[org])).rows[0].id;
  await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,$4,2)',[org,stores[0],reservedProduct,'0.300']);
  const pendingFractional=(quantity)=>post('/transfers',owner,{fromStoreId:stores[0],toStoreId:stores[1],needsApproval:true,items:[{productId:reservedProduct,quantity}]});
  const firstReserved=expectStatus(await pendingFractional(0.200),201).transfer;
  const secondReserved=expectStatus(await pendingFractional(0.100),201).transfer;
  assert.notEqual(firstReserved.id,secondReserved.id);
  const unavailable=await pendingFractional(0.001);
  assert.equal(unavailable.status,409,JSON.stringify(unavailable));
  assert.equal(unavailable.error.code,'INSUFFICIENT_AVAILABLE_STOCK');
  const reservedSnapshot=(await pool.query(`SELECT COALESCE(sum(ti.sent_quantity),0)::text AS reserved,count(*)::int AS n FROM stock_transfers t JOIN stock_transfer_items ti ON ti.transfer_id=t.id WHERE t.organization_id=$1 AND t.from_store_id=$2 AND ti.product_id=$3 AND t.status='pending'`,[org,stores[0],reservedProduct])).rows[0];
  assert.equal(Number(reservedSnapshot.reserved),0.3);
  assert.equal(reservedSnapshot.n,2,'rejected third reservation must not write a transfer');
  assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[0],reservedProduct])).rows[0].quantity),0.3);
  assert.equal(Number((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1 AND product_id=$2',[org,reservedProduct])).rows[0].n),0);
  const create=async()=>expectStatus(await post('/transfers',owner,{fromStoreId:stores[0],toStoreId:stores[1],needsApproval:false,items:[{productId:product,quantity:1}]}),201).transfer.id;
  const id=await create(),path=`/transfers/${id}/receive`;
  expectStatus(await post(path,sourceWorker,{items:[]}),403);
  for(const quantity of ['',null,-0.001,0.0004,'0.0004',1.0000000001,1000000000]){
   expectStatus(await post(path,owner,{items:[{productId:product,receivedQuantity:quantity}],differenceReason:'Invalid precision test'}),400);
   assert.equal((await pool.query('SELECT status FROM stock_transfers WHERE id=$1',[id])).rows[0].status,'dispatched');
  }
  expectStatus(await post(path,owner,{items:[{productId:product,receivedQuantity:0.125}],differenceReason:'Measured shortage'}),200);
  assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[stores[1],product])).rows[0].quantity),0.125);
  expectStatus(await post(path,owner,{items:[]}),409);
  const zero=await create();expectStatus(await post(`/transfers/${zero}/receive`,owner,{items:[{productId:product,receivedQuantity:0}],differenceReason:'Nothing arrived'}),200);
  const foreign=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Foreign transfer org','ACTIVE',CURRENT_DATE+30) RETURNING id")).rows[0].id;
  expectStatus(await post(path,await session(foreign,null,'OWNER'),{items:[]}),404);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()}
});
