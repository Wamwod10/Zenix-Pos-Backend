import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
test('product batch edits are tenant scoped and atomic including archive guards and audits',{skip:!url,timeout:30000},async()=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
 const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const post=async(token,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/products/bulk`,{method:'POST',headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:`zenix_session=${token}`},body:JSON.stringify(body)});return {status:response.status,...await response.json()}};
 try{
 const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Product batch','ACTIVE',CURRENT_DATE+30) RETURNING id")).rows[0].id;
 const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Batch store') RETURNING id",[org])).rows[0].id;
 const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Batch owner',$3,'unused','OWNER') RETURNING id",[org,store,randomUUID()])).rows[0].id;
 const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);
 const ids=(await pool.query("INSERT INTO products(organization_id,name,category,sell_price) VALUES($1,'Batch A','old',19),($1,'Batch B','old',29) RETURNING id",[org])).rows.map(row=>row.id).sort();
 let result=await post(token,{productIds:ids,patch:{category:'new'}});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.products.length,2);
 assert.deepEqual((await pool.query('SELECT category,sell_price::text FROM products WHERE id=ANY($1::uuid[]) ORDER BY sell_price',[ids])).rows,[{category:'new',sell_price:'19.00'},{category:'new',sell_price:'29.00'}]);
 const foreignOrg=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Foreign batch','ACTIVE',CURRENT_DATE+30) RETURNING id")).rows[0].id;
 const foreignProduct=(await pool.query("INSERT INTO products(organization_id,name,category) VALUES($1,'Foreign','foreign') RETURNING id",[foreignOrg])).rows[0].id;
 result=await post(token,{productIds:[ids[0],foreignProduct],patch:{category:'bad'}});assert.equal(result.status,404);
 assert.equal((await pool.query('SELECT category FROM products WHERE id=$1',[foreignProduct])).rows[0].category,'foreign');
 result=await post(token,{productIds:[ids[0],randomUUID()],patch:{category:'bad'}});assert.equal(result.status,404);
 assert.equal((await pool.query('SELECT category FROM products WHERE id=$1',[ids[0]])).rows[0].category,'new');
 const audits=async()=>Number((await pool.query("SELECT count(*) n FROM audit_logs WHERE organization_id=$1 AND entity_type='product'",[org])).rows[0].n);
 assert.equal(await audits(),2);
 await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,1,2)',[org,store,ids[1]]);
 result=await post(token,{productIds:ids,patch:{archived:true}});assert.equal(result.status,409,JSON.stringify(result));
 assert.equal((await pool.query('SELECT count(*)::int n FROM products WHERE id=ANY($1::uuid[]) AND archived=true',[ids])).rows[0].n,0);
 assert.equal(await audits(),2,'archive failure rolls back preceding product audit');
 result=await post(token,{productIds:[ids[0],ids[0]],patch:{archived:true}});assert.equal(result.status,200);assert.equal(result.data.products.length,1);
 result=await post(token,{productIds:[ids[0]],patch:{archived:false}});assert.equal(result.status,200);
 result=await post(token,{productIds:ids,patch:{sellPrice:0}});assert.equal(result.status,400);
 result=await post(token,{updates:ids.map((productId,index)=>({productId,patch:{category:`original-${index}`}}))});assert.equal(result.status,200);
 assert.deepEqual((await pool.query('SELECT category FROM products WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows.map(row=>row.category),['original-0','original-1']);
 const beforeUndoAudits=await audits();
 result=await post(token,{updates:[{productId:ids[0],patch:{category:'partial-undo'}},{productId:ids[1],patch:{archived:true}}]});assert.equal(result.status,409);
 assert.equal((await pool.query('SELECT category FROM products WHERE id=$1',[ids[0]])).rows[0].category,'original-0');assert.equal(await audits(),beforeUndoAudits);
 result=await post(token,{updates:[{productId:ids[0],patch:{category:'x'}},{productId:ids[0],patch:{category:'y'}}]});assert.equal(result.status,400);
 result=await post(token,{productIds:ids.map(id=>id.toUpperCase()),patch:{category:'uppercase'}});assert.equal(result.status,200);
 result=await post(token,{updates:[{productId:ids[0].toUpperCase(),patch:{category:'normalized'}}]});assert.equal(result.status,200);
 result=await post(token,{updates:[{productId:ids[0],patch:{category:'x'}},{productId:ids[0].toUpperCase(),patch:{category:'y'}}]});assert.equal(result.status,400);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()}
});

