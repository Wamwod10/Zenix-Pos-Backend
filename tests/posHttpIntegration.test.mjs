import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
(url?test:test.skip)('POS HTTP PostgreSQL: refunds, credit, replay, holds and two-tenant isolation',{timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
 const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,suffix=randomUUID();
 const request=async(path,{method='GET',body,token}={})=>{
  const response=await fetch(base+path,{method,headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:`zenix_session=${token}`},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return {status:response.status,...await response.json()};
 };
 const expectStatus=(result,status)=>{assert.equal(result.status,status,JSON.stringify(result));return result.data};
 try{
  const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES($1,'ACTIVE',CURRENT_DATE+30,4) RETURNING id",['POS fixture '+suffix])).rows[0].id;
  const otherOrg=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES($1,'ACTIVE',CURRENT_DATE+30) RETURNING id",['Other '+suffix])).rows[0].id;
  const stores=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'A'),($1,'B') RETURNING id",[org])).rows.map(row=>row.id),storeId=stores[0];
  const otherStore=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Foreign') RETURNING id",[otherOrg])).rows[0].id;
  const users={};
  for(const role of ['OWNER','MANAGER','CASHIER']){
   const user=(await pool.query('INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,$3,$4,$5,$3) RETURNING id',[org,role==='CASHIER'?storeId:null,role,role+suffix,'not-a-real-password'])).rows[0].id;
   const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);users[role]={id:user,token};
  }
  const product=(await pool.query("INSERT INTO products(organization_id,name,unit,sell_price,cost_price) VALUES($1,'Apples','kg',100,25) RETURNING id",[org])).rows[0].id;
  const foreignProduct=(await pool.query("INSERT INTO products(organization_id,name,sell_price) VALUES($1,'Foreign',100) RETURNING id",[otherOrg])).rows[0].id;
  await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,100,25)',[org,storeId,product]);
  const customer=(await pool.query("INSERT INTO customers(organization_id,name,phone) VALUES($1,'Buyer',$2) RETURNING id",[org,suffix])).rows[0].id;
  const shift=(await pool.query("INSERT INTO shifts(organization_id,store_id,cashier_id,opening_cash,status,register_key) VALUES($1,$2,$3,10000,'open',$4) RETURNING id",[org,storeId,users.CASHIER.id,`store:${storeId}`])).rows[0].id;
  const cashier=users.CASHIER.token,owner=users.OWNER.token;
  const saleBody=(ref,quantity=2,payments=[{method:'cash',amount:quantity*100}])=>({storeId,shiftId:shift,clientReference:ref,items:[{productId:product,quantity,unitPrice:100}],payments});
  let hold,sale;
  await t.test('least privilege and scoped hold validation',async()=>{
   expectStatus(await request('/api/users',{token:owner}),200);
   for(const role of ['MANAGER','CASHIER'])expectStatus(await request('/api/users',{token:users[role].token}),403);
   expectStatus(await request(`/api/sales/holds?storeId=${stores[1]}`,{token:cashier}),403);
   expectStatus(await request(`/api/sales/page?storeId=${otherStore}`,{token:cashier}),403);
   const invalid=await request('/api/sales/holds',{method:'POST',token:cashier,body:{storeId,name:'Invalid',cart:[{id:product,cartQty:0}]}});expectStatus(invalid,400);assert.ok(invalid.error.details.some(issue=>issue.path==='cart.0.cartQty'));
   expectStatus(await request('/api/sales/holds',{method:'POST',token:cashier,body:{storeId,name:'Foreign',cart:[{id:foreignProduct,cartQty:1}]}}),409);
   const body={storeId,shiftId:'',name:'Keep customer',cart:[{id:product,cartQty:2,sellPrice:100,discountPercent:0}],customerId:customer,clientReference:'hold-'+suffix};
   const results=await Promise.all([1,2].map(()=>request('/api/sales/holds',{method:'POST',token:cashier,body})));
   hold=expectStatus(results[0],201).hold;assert.equal(expectStatus(results[1],201).hold.id,hold.id);assert.equal(hold.customerId,customer);
   const listed=expectStatus(await request(`/api/sales/holds?storeId=${storeId}`,{token:cashier}),200).holds;assert.ok(listed.some(row=>row.id===hold.id));
   assert.equal(expectStatus(await request(`/api/sales/holds?storeId=${storeId}`,{token:owner}),200).holds.length,0);
  });
  await t.test('hold resume/delete and checkout are atomic and retryable',async()=>{
   const deletes=await Promise.all([1,2].map(()=>request(`/api/sales/holds/${hold.id}`,{method:'DELETE',token:cashier})));
   assert.deepEqual(deletes.map(result=>result.status).sort(),[200,404]);
   const body=saleBody(hold.clientReference);
   const results=await Promise.all([1,2].map(()=>request('/api/sales',{method:'POST',token:cashier,body})));
   sale=expectStatus(results[0],201).sale;assert.equal(expectStatus(results[1],201).sale.id,sale.id);
   assert.equal(Number((await pool.query('SELECT count(*) count FROM sales WHERE organization_id=$1 AND client_reference=$2',[org,hold.clientReference])).rows[0].count),1);
   expectStatus(await request('/api/sales',{method:'POST',token:cashier,body:{...body,payments:[{method:'card',amount:200}]}}),409);
  });
  await t.test('checkout reconciliation discloses only actor and branch scoped committed sales',async()=>{
   const path=`/api/sales/reconciliation?storeId=${storeId}&clientReference=${encodeURIComponent(hold.clientReference)}`;
   const found=expectStatus(await request(path,{token:cashier}),200);
   assert.equal(found.state,'confirmed');assert.equal(found.sale.id,sale.id);
   assert.equal(expectStatus(await request(path,{token:owner}),200).state,'unknown');
   expectStatus(await request(`/api/sales/reconciliation?storeId=${stores[1]}&clientReference=${hold.clientReference}`,{token:cashier}),403);
   assert.equal(expectStatus(await request(`/api/sales/reconciliation?storeId=${storeId}&clientReference=uncommitted-${suffix}`,{token:cashier}),200).state,'unknown');
  });
  await t.test('yesterday refund posts today, replays once and cannot exceed sold quantity',async()=>{
   await pool.query("UPDATE sales SET business_date=CURRENT_DATE-1,created_at=now()-interval '1 day' WHERE id=$1",[sale.id]);
   const body={productId:product,quantity:1,reason:'Broken item',refundMethod:'original',refundShiftId:shift,clientReference:'refund-'+suffix};
   const results=await Promise.all([1,2].map(()=>request(`/api/sales/${sale.id}/returns`,{method:'POST',token:cashier,body})));
   const ret=expectStatus(results[0],201).return;assert.equal(expectStatus(results[1],201).return.id,ret.id);assert.equal(Number(ret.amount),100);
   const date=(await pool.query('SELECT s.business_date::text sale_date,r.business_date::text return_date FROM sales s JOIN sale_returns r ON r.sale_id=s.id WHERE r.id=$1',[ret.id])).rows[0];assert.notEqual(date.sale_date,date.return_date);
   const last=await Promise.all([1,2].map(i=>request(`/api/sales/${sale.id}/returns`,{method:'POST',token:cashier,body:{...body,clientReference:`last-${i}-${suffix}`}})));
   assert.deepEqual(last.map(result=>result.status).sort(),[201,409]);
   const row=(await pool.query('SELECT total,returned_amount FROM sales WHERE id=$1',[sale.id])).rows[0];assert.equal(Number(row.total),200);assert.equal(Number(row.returned_amount),200);
   assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE store_id=$1 AND product_id=$2',[storeId,product])).rows[0].quantity),100);
  });
  await t.test('unpaid credit refund reduces debt; settled credit refunds captured repayment',async()=>{
   for(const settled of [false,true]){
    const body={...saleBody(`credit-${settled}-${suffix}`,1,[]),customerId:customer,creditAmount:100,creditDueDate:'2099-01-01'};
    const creditSale=expectStatus(await request('/api/sales',{method:'POST',token:cashier,body}),201).sale;
    if(settled){
     const credit=(await pool.query("SELECT id FROM customer_ledger WHERE sale_id=$1 AND entry_type='CREDIT_SALE'",[creditSale.id])).rows[0].id;
     const payment=(await pool.query("INSERT INTO customer_ledger(organization_id,customer_id,store_id,entry_type,amount,payment_method,created_by) VALUES($1,$2,$3,'PAYMENT',-100,'card',$4) RETURNING id",[org,customer,storeId,users.OWNER.id])).rows[0].id;
     await pool.query('INSERT INTO customer_payment_allocations(organization_id,customer_id,payment_ledger_id,credit_ledger_id,amount) VALUES($1,$2,$3,$4,100)',[org,customer,payment,credit]);
    }
    const result=expectStatus(await request(`/api/sales/${creditSale.id}/returns`,{method:'POST',token:cashier,body:{productId:product,quantity:1,reason:'Credit return',refundMethod:'original',clientReference:`credit-return-${settled}-${suffix}`}}),201).return;
    assert.equal(Number(result.refundBreakdown.card),settled?100:0);
    assert.equal(Number((await pool.query('SELECT COALESCE(sum(amount),0) debt FROM customer_ledger WHERE customer_id=$1',[customer])).rows[0].debt),0);
   }
  });
  await t.test('fractional refunds and thirds use exact stored amount and cap total',async()=>{
   const thirdSale=expectStatus(await request('/api/sales',{method:'POST',token:cashier,body:saleBody('thirds-'+suffix,3,[{method:'card',amount:300}])}),201).sale;
   // Disposable historical fixture whose final line total is not divisible by 3.
   await pool.query('UPDATE sale_items SET line_total=100 WHERE sale_id=$1',[thirdSale.id]);await pool.query('UPDATE sales SET total=100 WHERE id=$1',[thirdSale.id]);await pool.query('UPDATE sale_payments SET amount=100 WHERE sale_id=$1',[thirdSale.id]);
   const amounts=[];for(let i=0;i<3;i++)amounts.push(Number(expectStatus(await request(`/api/sales/${thirdSale.id}/returns`,{method:'POST',token:cashier,body:{productId:product,quantity:1,reason:'Third return',refundMethod:'original',clientReference:`third-${i}-${suffix}`}}),201).return.amount));
   assert.deepEqual(amounts,[33.33,33.34,33.33]);
   const weighted=expectStatus(await request('/api/sales',{method:'POST',token:cashier,body:saleBody('weighted-'+suffix,0.3,[{method:'card',amount:30}])}),201).sale;
   for(const quantity of [0.1,0.2])expectStatus(await request(`/api/sales/${weighted.id}/returns`,{method:'POST',token:cashier,body:{productId:product,quantity,reason:'Weighted return',refundMethod:'original',clientReference:`weighted-${quantity}-${suffix}`}}),201);
  });
  await t.test('audit is scoped and immutable; CRM bulk export is owner-only',async()=>{
   const audit=expectStatus(await request('/api/audit?type=return&limit=2',{token:owner}),200);assert.equal(audit.items.length,2);assert.equal(audit.items[0].type,'return');assert.ok(audit.items[0].metadata.quantity>0);assert.equal(audit.hasMore,true);
   expectStatus(await request('/api/audit',{token:cashier}),403);
   expectStatus(await request('/api/audit',{method:'POST',token:owner,body:{title:'Tamper'}}),404);
   expectStatus(await request('/api/customers/export',{token:cashier}),403);assert.equal(expectStatus(await request('/api/customers/export',{token:owner}),200).items.length,1);
  });
  await t.test('fractional quick receipt replays once with unit and exact cost',async()=>{
   const body={storeId,clientReference:'receive-'+suffix,lines:[{name:'Quick kg '+suffix,sku:'QUICK-'+suffix,unit:'kg',quantity:15.5,costPrice:8000,sellPrice:12000}]};
   const replies=await Promise.all([1,2].map(()=>request('/api/inventory/receive',{method:'POST',token:owner,body})));
   const first=expectStatus(replies[0],201);assert.equal(expectStatus(replies[1],201).receiptId,first.receiptId);assert.equal(first.total,124000);assert.equal(first.updated[0].unit,'kg');
   const saved=(await pool.query('SELECT unit FROM products WHERE id=$1',[first.updated[0].id])).rows[0];assert.equal(saved.unit,'kg');
   const path=`/api/inventory/receipt-reconciliation?storeId=${storeId}&clientReference=${body.clientReference}`;
   const found=expectStatus(await request(path,{token:owner}),200);assert.equal(found.state,'confirmed');assert.equal(found.receipt.receiptId,first.receiptId);
   assert.equal(expectStatus(await request(path,{token:users.MANAGER.token}),200).state,'unknown');
   assert.equal(Number((await pool.query('SELECT count(*) FROM stock_movements WHERE reference_id=$1',[first.receiptId])).rows[0].count),1);
  });
  await t.test('CRM debt payment replay and concurrency never double-allocate',async()=>{
   const creditSale=expectStatus(await request('/api/sales',{method:'POST',token:cashier,body:{...saleBody('crm-'+suffix,1,[]),customerId:customer,creditAmount:100,creditDueDate:'2099-01-01'}}),201).sale;
   const body={storeId,amount:25,paymentMethod:'card',clientReference:'crm-payment-'+suffix};
   const responses=await Promise.all([1,2].map(()=>request(`/api/customers/${customer}/payments`,{method:'POST',token:owner,body})));
   const first=expectStatus(responses[0],200).payment;assert.equal(expectStatus(responses[1],200).payment.id,first.id);
   expectStatus(await request(`/api/customers/${customer}/payments`,{method:'POST',token:owner,body:{...body,amount:30}}),409);
   assert.equal(Number((await pool.query('SELECT sum(amount) balance FROM customer_ledger WHERE customer_id=$1',[customer])).rows[0].balance),75);
   const detail=expectStatus(await request(`/api/customers/${customer}`,{token:owner}),200);assert.equal(detail.customer.balance,75);
   expectStatus(await request(`/api/sales/${creditSale.id}/returns`,{method:'POST',token:cashier,body:{productId:product,quantity:0.25,reason:'CRM partial refund',refundMethod:'original',clientReference:'crm-refund-'+suffix}}),201);
   const after=expectStatus(await request(`/api/customers/${customer}`,{token:owner}),200);assert.equal(after.customer.balance,50);assert.equal(after.customer.totalPurchases,75);assert.ok(after.returns.some(row=>row.saleId===creditSale.id&&row.amount===25));
  });
  await t.test('paged today records have products, units and real financial amounts without N+1 requests',async()=>{
   const page=expectStatus(await request(`/api/sales/page?storeId=${storeId}&limit=1`,{token:cashier}),200);
   assert.equal(page.items.length,1);assert.equal(page.items[0].items[0].unit,'kg');assert.equal(page.items[0].originalTotal,100);assert.equal(page.items[0].returnedTotal,25);assert.equal(page.items[0].netTotal,75);assert.equal(page.hasMore,true);
   const bootstrap=expectStatus(await request('/api/bootstrap',{token:owner}),200);
   const old=bootstrap.dailySales.find(row=>row.id===sale.id)||bootstrap.salesHistory.flatMap(day=>day.sales).find(row=>row.id===sale.id);
   assert.equal(old.returnedTotal,200);assert.equal(old.items[0].returnedQty,2);
  });
 }finally{await new Promise(resolve=>server.close(resolve));await pool.end()}
});
