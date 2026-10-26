import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {customerTodaySQL} from '../src/services/customerDirectory.js';

const url=process.env.TEST_DATABASE_URL;
test('master remediation HTTP RBAC, repayment reconciliation, replay and tenant boundaries',{skip:!url,timeout:90000},async()=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.DATABASE_URL,url);
 const [{app},{pool},{env}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/config/env.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(account,path,body,method=body===undefined?'GET':'POST')=>{
  const response=await fetch(base+path,{method,headers:{cookie:account.cookie,origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return {status:response.status,payload:await response.json()};
 };
 try{
  const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date,store_limit) VALUES('Master remediation HTTP','BUSINESS','ACTIVE','2099-01-01',2) RETURNING id")).rows[0].id;
  const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Branch A') RETURNING id",[org])).rows[0].id;
  const account=async(role,organizationId=org)=>{
   const id=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Synthetic role',$3,'unused',$4) RETURNING id",[organizationId,organizationId===org?store:null,randomUUID(),role])).rows[0].id;
   const token=randomUUID(),hash=createHash('sha256').update(token).digest('hex');
   await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[id,hash]);
   return {id,cookie:`${env.sessionCookieName}=${token}`,hash};
  };
  const roles={};for(const role of ['OWNER','ADMIN','MANAGER','CASHIER','SALES','WAREHOUSE'])roles[role]=await account(role);
  roles.PLATFORM_ADMIN=await account('PLATFORM_ADMIN',null);
  const created=await request(roles.OWNER,'/api/customers',{name:'Synthetic credit customer',creditLimit:100});assert.equal(created.status,201,JSON.stringify(created));const customer=created.payload.data.customer.id;
  let requestedLimit=120;
  for(const [role,actor] of Object.entries(roles)){
   const contact=await request(actor,`/api/customers/${customer}`,{phone:'998900000000'},'PATCH');
   assert.equal(contact.status,['WAREHOUSE','PLATFORM_ADMIN'].includes(role)?403:200,role+' contact');
   const update=await request(actor,`/api/customers/${customer}`,{creditLimit:requestedLimit++},'PATCH');
   assert.equal(update.status,['OWNER','ADMIN'].includes(role)?200:403,role+' financial');
  }
  for(const actor of [roles.MANAGER,roles.CASHIER]){
   await pool.query("UPDATE users SET permission_overrides=$2 WHERE id=$1",[actor.id,{customerFinancialWrite:true}]);
   assert.equal((await request(actor,`/api/customers/${customer}`,{defaultCreditDays:30},'PATCH')).status,200);
   await pool.query("UPDATE users SET permission_overrides=$2 WHERE id=$1",[actor.id,{customerFinancialWrite:false}]);
   assert.equal((await request(actor,`/api/customers/${customer}`,{defaultCreditDays:31},'PATCH')).status,403);
  }
  const foreignOrg=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Foreign remediation fixture','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  const foreign=(await pool.query("INSERT INTO customers(organization_id,name) VALUES($1,'Foreign customer') RETURNING id",[foreignOrg])).rows[0].id;
  assert.equal((await request(roles.OWNER,`/api/customers/${foreign}`,{creditLimit:10},'PATCH')).status,404);
  for(const workspaceSettings of [{organization:{timezone:'Invalid/Zone'}},{businessDay:{startTime:'25:00'}},{storeOverrides:{[store]:{businessDay:{startTime:'12:99'}}}}])assert.equal((await request(roles.OWNER,'/api/settings/workspace',{workspaceSettings},'PATCH')).status,400);
  const opened=await request(roles.OWNER,'/api/shifts/open',{storeId:store,openingCash:0});assert.equal(opened.status,201,JSON.stringify(opened));const shiftId=opened.payload.data.shift.id;
  await pool.query("INSERT INTO customer_ledger(organization_id,customer_id,store_id,entry_type,amount) VALUES($1,$2,$3,'CREDIT_SALE',100)",[org,customer,store]);
  const path=`/api/customers/${customer}/payments`,cash={clientReference:randomUUID(),storeId:store,shiftId,amount:30,paymentMethod:'cash'};
  const same=await Promise.all([request(roles.OWNER,path,cash),request(roles.OWNER,path,cash)]);assert.equal(same[0].status,200,JSON.stringify(same));assert.equal(same[1].status,200);assert.equal(same[0].payload.data.payment.id,same[1].payload.data.payment.id);
  assert.equal((await request(roles.CASHIER,path,{...cash,clientReference:randomUUID()})).status,403);
  assert.equal((await request(roles.OWNER,path,{...cash,amount:31})).status,409);
  const parallel=await Promise.all([request(roles.OWNER,path,{...cash,clientReference:randomUUID(),amount:40}),request(roles.OWNER,path,{...cash,clientReference:randomUUID(),amount:40})]);assert.deepEqual(parallel.map(r=>r.status).sort(),[200,409]);
  for(const [paymentMethod,amount] of [['card',20],['transfer',10]])assert.equal((await request(roles.OWNER,path,{clientReference:randomUUID(),storeId:store,paymentMethod,amount})).status,200);
  assert.equal((await request(roles.OWNER,path,{storeId:store,paymentMethod:'card',amount:1})).status,400);
  const counts=(await pool.query("SELECT (SELECT count(*) FROM customer_ledger WHERE customer_id=$1 AND entry_type='PAYMENT') payments,(SELECT sum(amount) FROM customer_ledger WHERE customer_id=$1) balance,(SELECT sum(m.amount) FROM shift_movements m JOIN customer_ledger l ON l.id=m.customer_payment_ledger_id WHERE l.customer_id=$1) cash",[customer])).rows[0];assert.deepEqual(counts,{payments:'4',balance:'0.00',cash:'70.00'});
  const summary=await request(roles.OWNER,`/api/shifts/${shiftId}/summary`);assert.equal(summary.payload.data.summary.expectedCash,70);
  assert.equal((await request(roles.OWNER,`/api/shifts/${shiftId}/close`,{actualCash:70,expectedCash:70})).status,200);
  assert.equal((await request(roles.OWNER,path,cash)).payload.data.payment.id,same[0].payload.data.payment.id,'closed-shift retry confirms prior result');
  const supplier=(await pool.query("INSERT INTO suppliers(organization_id,name) VALUES($1,'Synthetic supplier') RETURNING id",[org])).rows[0].id;
  const invoice={clientReference:randomUUID(),storeId:store,invoiceNo:'Synthetic',total:100,paidAmount:0,paymentMethod:'purchase'};
  const invoices=await Promise.all([request(roles.OWNER,`/api/suppliers/${supplier}/invoices`,invoice),request(roles.OWNER,`/api/suppliers/${supplier}/invoices`,invoice)]);assert.equal(invoices[0].status,201,JSON.stringify(invoices));assert.equal(invoices[1].status,201);assert.equal(invoices[0].payload.data.invoice.id,invoices[1].payload.data.invoice.id);
  const {clientReference,...withoutReference}=invoice;assert.equal((await request(roles.OWNER,`/api/suppliers/${supplier}/invoices`,withoutReference)).status,400);
  await pool.query("UPDATE organizations SET timezone='Pacific/Kiritimati' WHERE id=$1",[org]);
  const calendar=customerTodaySQL.replace('now()','$2::timestamptz');assert.equal((await pool.query(`SELECT (${calendar})::text AS calendar_day`,[org,'2026-10-25T12:00:00Z'])).rows[0].calendar_day,'2026-10-26');
  await pool.query("UPDATE organizations SET timezone='Pacific/Pago_Pago' WHERE id=$1",[org]);assert.equal((await pool.query(`SELECT (${calendar})::text AS calendar_day`,[org,'2026-10-25T01:00:00Z'])).rows[0].calendar_day,'2026-10-24');
  await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1',[roles.SALES.hash]);assert.equal((await request(roles.SALES,'/api/customers')).status,401);
 }finally{await new Promise(r=>server.close(r));await pool.end()}
});
