import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
test('POS Pro real HTTP/PostgreSQL uses shared inventory, payments, shifts, holds and reports',{skip:!url,timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
 const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`,suffix=randomUUID();
 const request=async(path,body,token)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:`zenix_session=${token}`},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()}};
 const status=(r,n)=>{assert.equal(r.status,n,JSON.stringify(r));return r.data};
 try{
  const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit,settings) VALUES($1,'ACTIVE','2099-01-01',3,$2) RETURNING id",['Phase 2 '+suffix,{workspaceSettings:{pos:{cashierDiscountAllowed:true,discountLimit:20}}}])).rows[0].id;
  const foreign=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES($1,'ACTIVE','2099-01-01') RETURNING id",['Foreign '+suffix])).rows[0].id;
  const storeId=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Local test branch') RETURNING id",[org])).rows[0].id;
  const otherStore=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Foreign branch') RETURNING id",[foreign])).rows[0].id;
  const users=[];
  for(let i=0;i<2;i++){
   const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Cashier',$3,'test-only','CASHIER') RETURNING id",[org,storeId,'pos-pro-'+suffix+i])).rows[0].id;
   const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);users.push({id:user,token});
  }
  const token=users[0].token;
  const shiftId=(await pool.query("INSERT INTO shifts(organization_id,store_id,cashier_id,opening_cash,register_key) VALUES($1,$2,$3,10000,$4) RETURNING id",[org,storeId,users[0].id,`store:${storeId}`])).rows[0].id;
  const product=(await pool.query("INSERT INTO products(organization_id,name,barcode,unit,sell_price) VALUES($1,'Weighted apple','00123','kg',12000) RETURNING id",[org])).rows[0].id;
  await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,10)',[org,storeId,product]);
  const body=(ref,quantity=1.25)=>({storeId,shiftId,clientReference:ref,items:[{productId:product,quantity,unitPrice:12000,metadata:{originalUnitPrice:12000}}],payments:[{method:'cash',amount:quantity*12000}],metadata:{source:'pos-pro',cashTendered:quantity*12000}});
  let first;
  await t.test('closed/foreign scope, external confirmation and stale pricing reject without stock writes',async()=>{
   status(await request(`/api/sales/pos-pro/summary?storeId=${otherStore}`,null,token),403);
   status(await request('/api/sales',{...body('no-shift'),shiftId:randomUUID()},token),409);
   const card={...body('unconfirmed'),payments:[{method:'card',amount:15000}]};status(await request('/api/sales',card,token),409);
   status(await request('/api/sales',{...body('stale'),items:[{productId:product,quantity:1.25,unitPrice:11000,metadata:{originalUnitPrice:11000}}]},token),409);
   status(await request('/api/sales',{...body('raise'),items:[{productId:product,quantity:1.25,unitPrice:13000,metadata:{originalUnitPrice:12000}}]},token),403);
   assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[product])).rows[0].quantity),10);
  });
  await t.test('double submit commits exactly once and remains visible to ordinary sales',async()=>{
   const sale=body('PRO-'+suffix),results=await Promise.all([request('/api/sales',sale,token),request('/api/sales',sale,token)]);
   first=status(results[0],201).sale;assert.equal(status(results[1],201).sale.id,first.id);
   assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[product])).rows[0].quantity),8.75);
   const page=status(await request(`/api/sales/page?storeId=${storeId}`,null,token),200);assert.ok(page.items.some(s=>s.id===first.id));
   assert.equal(status(await request(`/api/sales/reconciliation?storeId=${storeId}&clientReference=${sale.clientReference}`,null,token),200).sale.id,first.id);
   const summary=status(await request(`/api/sales/pos-pro/summary?storeId=${storeId}&shiftId=${shiftId}`,null,token),200);assert.equal(summary.total,15000);assert.equal(summary.cash,15000);assert.equal(summary.count,1);assert.equal(summary.popular[0].product_id,product);
  });
  await t.test('two cashiers share one stock lock, insufficient stock never goes negative',async()=>{
   const attempts=await Promise.all(users.map((u,i)=>request('/api/sales',body('race-'+suffix+i,6),u.token)));
   assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409]);assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[product])).rows[0].quantity),2.75);
  });
  await t.test('split manually confirmed payment, line discount, live summary and ordinary legacy checkout agree',async()=>{
   const split={...body('split-'+suffix,1),payments:[{method:'cash',amount:4000},{method:'card',amount:6800}],items:[{productId:product,quantity:1,unitPrice:10800,metadata:{originalUnitPrice:12000}}],metadata:{source:'pos-pro',cashTendered:5000,externalPaymentConfirmation:'manual-confirmed'}};
   const saved=status(await request('/api/sales',split,token),201).sale;assert.equal(Number(saved.total),10800);
   const legacy={...body('legacy-'+suffix,.5),metadata:{}};status(await request('/api/sales',legacy,token),201);
   const summary=status(await request(`/api/sales/pos-pro/summary?storeId=${storeId}`,null,token),200);assert.equal(summary.count,4);assert.equal(summary.total,103800);assert.equal(summary.card,6800);assert.equal(summary.cash,97000);
   // Existing notification pipeline receives the same canonical sale event.
   assert.equal(Number((await pool.query("SELECT count(*) n FROM audit_logs WHERE organization_id=$1 AND entity_type='sale'",[org])).rows[0].n),4);
   assert.equal(Number((await pool.query("SELECT count(*) n FROM notification_outbox WHERE organization_id=$1 AND event_type='sale.completed'",[org])).rows[0].n),4);
   status(await request(`/api/sales/${first.id}/returns`,{productId:product,quantity:.25,reason:'Test refund',refundMethod:'original',refundShiftId:shiftId,clientReference:'return-'+suffix},token),201);
   const after=status(await request(`/api/sales/pos-pro/summary?storeId=${storeId}`,null,token),200);assert.equal(after.total,100800);assert.equal(after.cash,94000);
  });
 }finally{await new Promise(r=>server.close(r));await pool.end()}
});
