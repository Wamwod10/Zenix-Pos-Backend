import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';

const url=process.env.TEST_DATABASE_URL;
test('supplier payments and expenses preserve money, replay and tenant boundaries',{skip:!url,timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
 const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const request=async(path,token,body,method='POST')=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:`zenix_session=${token}`},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return {status:response.status,...await response.json()};
 };
 const expectStatus=(result,status)=>{assert.equal(result.status,status,JSON.stringify(result));return result.data};
 async function fixture(role='OWNER'){
  const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('Financial safety test','ACTIVE',CURRENT_DATE+30) RETURNING id")).rows[0].id;
  const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'A') RETURNING id",[org])).rows[0].id;
  const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Test',$3,'unused',$4) RETURNING id",[org,store,randomUUID(),role])).rows[0].id;
  const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);
  const supplier=(await pool.query("INSERT INTO suppliers(organization_id,name) VALUES($1,'Supplier') RETURNING id",[org])).rows[0].id;
  const shift=(await pool.query("INSERT INTO shifts(organization_id,store_id,cashier_id,opening_cash,register_key) VALUES($1,$2,$3,1000,$4) RETURNING id",[org,store,user,`store:${store}`])).rows[0].id;
  return {org,store,user,token,supplier,shift};
 }
 const invoice=async(f,total)=>(await pool.query('INSERT INTO supplier_invoices(organization_id,supplier_id,store_id,total) VALUES($1,$2,$3,$4) RETURNING id',[f.org,f.supplier,f.store,total])).rows[0].id;
 try{
  await t.test('concurrent and lost-response supplier payment retry changes debt and cash exactly once',async()=>{
   const f=await fixture();const id=await invoice(f,300);
   const body={storeId:f.store,shiftId:f.shift,fromRegister:true,invoiceId:id,amount:100,method:'cash',note:'test',clientReference:randomUUID()};
   const path=`/api/suppliers/${f.supplier}/payments`;
   const results=await Promise.all([request(path,f.token,body),request(path,f.token,body)]);
   const row=expectStatus(results[0],201).payment;assert.equal(expectStatus(results[1],201).payment.id,row.id);
   assert.equal(expectStatus(await request(path,f.token,body),201).payment.id,row.id);
   assert.equal(Number((await pool.query('SELECT paid_amount FROM supplier_invoices WHERE id=$1',[id])).rows[0].paid_amount),100);
   assert.equal(Number((await pool.query("SELECT sum(amount) amount FROM shift_movements WHERE shift_id=$1 AND source='supplier'",[f.shift])).rows[0].amount),100);
   for(const change of [{amount:90},{note:'different'},{method:'card',fromRegister:false},{shiftId:randomUUID()}]){
    const conflict=await request(path,f.token,{...body,...change});expectStatus(conflict,409);assert.equal(conflict.error.code,'IDEMPOTENCY_CONFLICT');
   }
  });
  await t.test('supplier invoice and payment reject blank/null and sub-cent input before any write',async()=>{
   const f=await fixture(),invoicePath=`/api/suppliers/${f.supplier}/invoices`,payPath=`/api/suppliers/${f.supplier}/payments`;
   const invoiceBody={storeId:f.store,invoiceNo:'FIN-002',total:100.30,paidAmount:0.10,paymentMethod:'card'};
   const invalidMoney=[0.001,'0.001',127000.00000001,'127000.00000001','',null];
   for(const value of invalidMoney){
    const invalidTotal=await request(invoicePath,f.token,{...invoiceBody,total:value,clientReference:randomUUID()});
    expectStatus(invalidTotal,400);
    const invalidPaid=await request(invoicePath,f.token,{...invoiceBody,paidAmount:value,clientReference:randomUUID()});
    expectStatus(invalidPaid,400);
   }
   assert.equal(Number((await pool.query('SELECT count(*) AS n FROM supplier_invoices WHERE supplier_id=$1',[f.supplier])).rows[0].n),0);
   assert.equal(Number((await pool.query('SELECT count(*) AS n FROM supplier_payments WHERE supplier_id=$1',[f.supplier])).rows[0].n),0);
   assert.equal(Number((await pool.query('SELECT count(*) AS n FROM financial_write_replays WHERE organization_id=$1',[f.org])).rows[0].n),0);
   const valid=expectStatus(await request(invoicePath,f.token,{...invoiceBody,clientReference:randomUUID()}),201).invoice;
   assert.ok(valid.id,'valid 2-decimal invoice accepted');
   for(const value of invalidMoney){
    const result=await request(payPath,f.token,{storeId:f.store,invoiceId:valid.id,amount:value,method:'card',clientReference:randomUUID()});
    expectStatus(result,400);
   }
   assert.equal((await pool.query("SELECT sum(total-paid_amount)::text AS debt FROM supplier_invoices WHERE supplier_id=$1",[f.supplier])).rows[0].debt,'100.20');
   assert.equal(Number((await pool.query('SELECT count(*) AS n FROM supplier_payments WHERE supplier_id=$1',[f.supplier])).rows[0].n),1,'only valid invoice initial payment is persisted');
   assert.equal(Number((await pool.query("SELECT count(*) AS n FROM shift_movements WHERE organization_id=$1 AND source='supplier'",[f.org])).rows[0].n),0);
   const paid=expectStatus(await request(payPath,f.token,{storeId:f.store,invoiceId:valid.id,amount:100.20,method:'card',clientReference:randomUUID()}),201).payment;
   assert.ok(paid.id);
   assert.equal((await pool.query("SELECT sum(total-paid_amount)::text AS debt FROM supplier_invoices WHERE supplier_id=$1",[f.supplier])).rows[0].debt,'0.00');
  });
  await t.test('supplier debt never accepts even a one-cent overpayment or sub-cent input',async()=>{
   const f=await fixture();const id=await invoice(f,'0.10');const body={storeId:f.store,invoiceId:id,amount:0.11,method:'card',clientReference:randomUUID()};
   const result=await request(`/api/suppliers/${f.supplier}/payments`,f.token,body);expectStatus(result,409);assert.equal(result.error.code,'PAYMENT_EXCEEDS_DEBT');
   expectStatus(await request(`/api/suppliers/${f.supplier}/payments`,f.token,{...body,amount:0.001}),400);
   assert.equal(Number((await pool.query('SELECT paid_amount FROM supplier_invoices WHERE id=$1',[id])).rows[0].paid_amount),0);
   assert.equal(Number((await pool.query('SELECT count(*) n FROM financial_write_replays WHERE organization_id=$1',[f.org])).rows[0].n),0,'failed writes leave no successful replay');
   expectStatus(await request(`/api/suppliers/${f.supplier}/payments`,f.token,{...body,amount:0.1}),201);
  });
  await t.test('different concurrent references cannot overpay and decimal allocations close exactly',async()=>{
   const f=await fixture();const id=await invoice(f,100);const body={storeId:f.store,invoiceId:id,amount:60,method:'card'};
   const results=await Promise.all([1,2].map(()=>request(`/api/suppliers/${f.supplier}/payments`,f.token,{...body,clientReference:randomUUID()})));
   assert.deepEqual(results.map(result=>result.status).sort(),[201,409]);
   assert.equal(Number((await pool.query('SELECT paid_amount FROM supplier_invoices WHERE id=$1',[id])).rows[0].paid_amount),60);
   const decimals=await fixture();await invoice(decimals,'0.10');await invoice(decimals,'0.20');
   expectStatus(await request(`/api/suppliers/${decimals.supplier}/payments`,decimals.token,{storeId:decimals.store,amount:0.3,method:'card',clientReference:randomUUID()}),201);
   assert.equal((await pool.query('SELECT sum(total-paid_amount)::text debt FROM supplier_invoices WHERE supplier_id=$1',[decimals.supplier])).rows[0].debt,'0.00');
  });
  await t.test('expense POST and PATCH reject sub-cent input without ledger, cash or audit mutations',async()=>{
   const f=await fixture(),bad=['',null,0,0.001,'0.001',25.00000001,'127000.00000001'];
   for(const amount of bad){
    const result=await request('/api/expenses',f.token,{storeId:f.store,title:'Expense invalid',amount,paymentMethod:'card',clientReference:randomUUID()});
    expectStatus(result,400);
   }
   assert.equal(Number((await pool.query('SELECT count(*) n FROM expenses WHERE organization_id=$1',[f.org])).rows[0].n),0);
   assert.equal(Number((await pool.query("SELECT count(*) n FROM shift_movements WHERE organization_id=$1 AND source='expense'",[f.org])).rows[0].n),0);
   assert.equal(Number((await pool.query('SELECT count(*) n FROM financial_write_replays WHERE organization_id=$1',[f.org])).rows[0].n),0);
   const created=expectStatus(await request('/api/expenses',f.token,{storeId:f.store,title:'Expense valid',category:'Travel',note:'Card payment',amount:'25.50',paymentMethod:'card',clientReference:randomUUID()}),201).expense;
   for(const amount of bad){
    expectStatus(await request(`/api/expenses/${created.id}`,f.token,{amount},'PATCH'),400);
   }
   assert.equal((await pool.query('SELECT amount::text amount FROM expenses WHERE id=$1',[created.id])).rows[0].amount,'25.50');
   assert.equal(Number((await pool.query("SELECT count(*) n FROM audit_logs WHERE organization_id=$1 AND entity_type='expense' AND action='update'",[f.org])).rows[0].n),0);
   expectStatus(await request(`/api/expenses/${created.id}`,f.token,{amount:'25.51'},'PATCH'),200);
   assert.equal((await pool.query('SELECT amount::text amount FROM expenses WHERE id=$1',[created.id])).rows[0].amount,'25.51');
   const updated=(await pool.query('SELECT payment_method,category,note,shift_id FROM expenses WHERE id=$1',[created.id])).rows[0];
   assert.deepEqual(updated,{payment_method:'card',category:'Travel',note:'Card payment',shift_id:null},'amount-only PATCH must preserve other fields');
  });
  await t.test('expense retries post one expense and one cash movement; changed intent conflicts',async()=>{
   const f=await fixture();const body={storeId:f.store,shiftId:f.shift,title:'Transport',amount:25.50,paymentMethod:'cash',clientReference:randomUUID()};
   const results=await Promise.all([request('/api/expenses',f.token,body),request('/api/expenses',f.token,body)]);
   const row=expectStatus(results[0],201).expense;assert.equal(expectStatus(results[1],201).expense.id,row.id);
   const changed=await request('/api/expenses',f.token,{...body,amount:30});expectStatus(changed,409);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');
   assert.equal(Number((await pool.query("SELECT count(*) n FROM shift_movements WHERE shift_id=$1 AND source='expense'",[f.shift])).rows[0].n),1);
   expectStatus(await request('/api/expenses',f.token,{...body,clientReference:randomUUID(),amount:0.001}),400);
   expectStatus(await request(`/api/expenses/${row.id}`,f.token,undefined,'DELETE'),200);
   assert.equal(expectStatus(await request('/api/expenses',f.token,body),201).expense.id,row.id);
   assert.equal(Number((await pool.query('SELECT count(*) n FROM expenses WHERE id=$1',[row.id])).rows[0].n),0,'a completed retry must never resurrect a deleted expense');
  });
  await t.test('payment references remain tenant and actor scoped; cashier cannot post supplier payments',async()=>{
   const a=await fixture(),b=await fixture(),cashier=await fixture('CASHIER');const ref=randomUUID();
   await assert.rejects(pool.query("INSERT INTO financial_write_replays(organization_id,operation,client_reference,user_id,request_fingerprint,result) VALUES($1,'supplier_payment',$2,$3,'invalid','{}'::jsonb)",[a.org,randomUUID(),b.user]),error=>error.code==='23503'&&error.constraint==='financial_replays_actor_tenant_fk');
   for(const f of [a,b]){
    const id=await invoice(f,100);expectStatus(await request(`/api/suppliers/${f.supplier}/payments`,f.token,{storeId:f.store,invoiceId:id,amount:10,method:'card',clientReference:ref}),201);
   }
   const otherUser=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Other owner',$3,'unused','OWNER') RETURNING id",[a.org,a.store,randomUUID()])).rows[0].id;
   const otherToken=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[otherUser,sha256(otherToken)]);
   const original=(await pool.query('SELECT result FROM financial_write_replays WHERE organization_id=$1 AND client_reference=$2',[a.org,ref])).rows[0].result;
   const denied=await request(`/api/suppliers/${a.supplier}/payments`,otherToken,{storeId:a.store,invoiceId:original.invoice_id,amount:10,method:'card',clientReference:ref});expectStatus(denied,409);assert.equal(denied.error.code,'IDEMPOTENCY_CONFLICT');
   expectStatus(await request(`/api/suppliers/${a.supplier}/payments`,b.token,{storeId:b.store,amount:10,method:'card',clientReference:randomUUID()}),404);
   expectStatus(await request(`/api/suppliers/${cashier.supplier}/payments`,cashier.token,{storeId:cashier.store,amount:10,method:'card'}),403);
   expectStatus(await request('/api/expenses',b.token,{storeId:a.store,title:'Foreign',amount:10,paymentMethod:'card'}),404);
  });
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()}
});
