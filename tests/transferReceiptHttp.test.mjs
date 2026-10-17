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
  const create=async()=>expectStatus(await post('/transfers',owner,{fromStoreId:stores[0],toStoreId:stores[1],needsApproval:false,items:[{productId:product,quantity:1}]}),201).transfer.id;
  const id=await create(),path=`/transfers/${id}/receive`;
  expectStatus(await post(path,sourceWorker,{items:[]}),403);
  for(const quantity of [0.0004,1000000000]){
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
