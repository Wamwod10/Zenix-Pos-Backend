import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.AI_AGENT_TEST_DATABASE_URL;
test('authenticated agent HTTP enforces explicit immutable confirmation and keeps POS available',{skip:!url,timeout:60000},async()=>{
 assertSafeTestDatabaseUrl(url);process.env.NODE_ENV='test';process.env.DATABASE_URL=url;
 const [{default:express},{default:cookieParser},{pool},{createAiRouter},{default:products},{requireTrustedClient},{errorHandler},{sha256},{aiSettings,tokenCostMicros}]=await Promise.all([
  import('express'),import('cookie-parser'),import('../src/db/pool.js'),import('../src/routes/ai.js'),import('../src/routes/products.js'),import('../src/middleware/clientGuard.js'),import('../src/middleware/error.js'),import('../src/lib/crypto.js'),import('../src/config/ai.js')]);
 const settings={...aiSettings(),enabled:true,writesEnabled:true,userPerMinute:10,businessPerMinute:30};
 let response;
 const provider=async(_history,{onDispatch})=>{await onDispatch();if(response instanceof Error)throw response;return response};provider.agent=true;
 const app=express();app.use(express.json(),cookieParser(),requireTrustedClient);
 app.use('/api/ai',createAiRouter({settings,provider}));app.use('/api/products',products);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function fixture(){
  const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Agent HTTP test','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'HTTP store') RETURNING id",[org])).rows[0].id;
  const warehouse=(await pool.query('SELECT id FROM warehouses WHERE organization_id=$1 AND store_id=$2',[org,store])).rows[0].id;
  const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'HTTP agent',$3,'test','OWNER') RETURNING id",[org,store,randomUUID()])).rows[0].id;
  const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day')",[user,sha256(token)]);
  const product=(await pool.query("INSERT INTO products(organization_id,name,unit,cost_price) VALUES($1,'Guruch HTTP','kg',1000) RETURNING id",[org])).rows[0].id;
  return {org,store,warehouse,product,cookie:`zenix_session=${token}`};
 }
 async function request(path,{cookie,method='GET',body,trusted=true}={}){
  const headers={'Content-Type':'application/json',Origin:'http://localhost:5173'};if(cookie)headers.Cookie=cookie;if(trusted)headers['x-zenix-client']='web';
  const r=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
 }
 try{
  const a=await fixture(),b=await fixture();
  assert.equal((await request('/api/ai/status')).status,401);
  assert.equal((await request('/api/ai/chat',{cookie:a.cookie,method:'POST',trusted:false,body:{}})).status,403);
  assert.equal((await request('/api/ai/chat',{cookie:a.cookie,method:'POST',body:{requestId:randomUUID(),question:'salom',organizationId:b.org}})).status,400);
  response=new Error('private provider detail');
  const failure=await request('/api/ai/chat',{cookie:a.cookie,method:'POST',body:{requestId:randomUUID(),question:'Salom'}});assert.equal(failure.status,503);assert.ok(!JSON.stringify(failure.data).includes('private'));
  assert.equal((await request('/api/products',{cookie:a.cookie})).status,200);
  const args={productId:a.product,storeId:a.store,warehouseId:a.warehouse,quantity:10,unit:'kg',costPrice:1000,batchNo:null,expiryDate:null},callId=randomUUID();
  response={calls:[{callId,name:'prepare_stock_receipt',args}],items:[{type:'function_call',call_id:callId,name:'prepare_stock_receipt',arguments:JSON.stringify(args),status:'completed'}],reply:null,inputTokens:100,outputTokens:20,cost:tokenCostMicros(100,20)};
  const preview=await request('/api/ai/chat',{cookie:a.cookie,method:'POST',body:{requestId:randomUUID(),question:'Guruch HTTP mahsulotidan 10 kg tayyorla'}});assert.equal(preview.status,200,JSON.stringify(preview.data));
  const action=preview.data.data.actions[0],path=`/api/ai/actions/${action.id}/confirm`;
  assert.equal((await request(path,{cookie:a.cookie,method:'POST',body:{}})).status,400);
  assert.equal((await request(path,{cookie:a.cookie,method:'POST',body:{confirmationToken:action.confirmationToken,quantity:20}})).status,400);
  assert.equal((await request(path,{cookie:a.cookie,method:'POST',body:{confirmationToken:'a'.repeat(43)}})).status,403);
  assert.equal((await request(path,{cookie:b.cookie,method:'POST',body:{confirmationToken:action.confirmationToken}})).status,404);
  assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[a.org])).rows[0].n,0);
  for(let i=0;i<2;i++){const r=await request(path,{cookie:a.cookie,method:'POST',body:{confirmationToken:action.confirmationToken}});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.data.status,'CONFIRMED');assert.equal(r.data.data.result.after,10)}
  assert.equal((await pool.query('SELECT count(*)::int n FROM stock_movements WHERE organization_id=$1',[a.org])).rows[0].n,1);
 }finally{await new Promise(r=>server.close(r));await pool.end()}
});
