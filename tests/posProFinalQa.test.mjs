import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedPosProQa} from '../scripts/seed-pos-pro-qa.mjs';
test('supermarket final QA: real HTTP money, credit, units, scope and shift lifecycle',{skip:!process.env.TEST_DATABASE_URL,timeout:60000},async t=>{
 const [{app},{pool}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js')]);const fixture=await seedPosProQa(pool),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,body,cookie='')=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 const expectStatus=(r,status)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body.data};
 try{
  const cashier=(await request('/api/auth/login',fixture.users.cashier)).cookie,second=(await request('/api/auth/login',fixture.users.second)).cookie,manager=(await request('/api/auth/login',fixture.users.manager)).cookie;assert.ok(cashier&&second&&manager);
  const shift=expectStatus(await request('/api/shifts/open',{storeId:fixture.stores[0],openingCash:10000},cashier),201).shift;
  const packet=(index,quantity=1)=>({storeId:fixture.stores[0],shiftId:shift.id,clientReference:randomUUID(),items:[{productId:fixture.products[index].id,quantity,unitPrice:fixture.products[index].price,metadata:{originalUnitPrice:fixture.products[index].price}}],payments:[{method:'cash',amount:fixture.products[index].price*quantity}],metadata:{source:'pos-pro',cashTendered:fixture.products[index].price*quantity}});
  await t.test('zero, negative, short and excess payments reject atomically',async()=>{
   const initial=Number((await pool.query('SELECT count(*) n FROM sales WHERE organization_id=$1',[fixture.org])).rows[0].n);
   for(const payments of [[],[{method:'cash',amount:0}],[{method:'cash',amount:-1}],[{method:'cash',amount:126999}],[{method:'card',amount:127001}]]){const result=await request('/api/sales',{...packet(6),payments},cashier);assert.ok(result.status>=400,JSON.stringify(result))}
   const short=await request('/api/sales',{...packet(6),metadata:{source:'pos-pro',cashTendered:126999}},cashier);assert.ok(short.status>=400,JSON.stringify(short));
   assert.equal(Number((await pool.query('SELECT count(*) n FROM sales WHERE organization_id=$1',[fixture.org])).rows[0].n),initial);assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[fixture.products[6].id])).rows[0].quantity),20);
  });
  await t.test('127000 exact cash and 180000 split share canonical payment/audit records',async()=>{
   const cash=expectStatus(await request('/api/sales',{...packet(6),metadata:{source:'pos-pro',cashTendered:150000,change:23000}},cashier),201).sale;assert.equal(Number(cash.total),127000);assert.equal(cash.metadata.change,23000);
   const split=expectStatus(await request('/api/sales',{...packet(7),payments:[{method:'cash',amount:80000},{method:'card',amount:100000}],metadata:{source:'pos-pro',cashTendered:80000,change:0,externalPaymentConfirmation:'manual-confirmed'}},cashier),201).sale;assert.equal(Number(split.total),180000);assert.deepEqual(split.payments.map(p=>[p.method,p.amount]),[['cash',80000],['card',100000]]);
  });
  await t.test('credit needs customer, limit and due date; deposit ledger is exact',async()=>{
   const credit={...packet(8),payments:[{method:'cash',amount:5000}],creditAmount:15000,customerId:fixture.customer,creditDueDate:'2099-01-01',metadata:{source:'pos-pro',cashTendered:5000,change:0}};
   const missing=await request('/api/sales',{...credit,customerId:undefined},cashier);assert.ok(missing.status>=400);
   const noDate=await request('/api/sales',{...credit,creditDueDate:undefined},cashier);assert.equal(noDate.status,409);assert.equal(noDate.body.error.code,'CREDIT_DUE_DATE_REQUIRED');
   assert.equal((await request('/api/sales',{...credit,creditDueDate:'not-a-date'},cashier)).status,400);
   for(const invalid of ['2026-02-30','2026-13-01','0000-01-01']){
    const result=await request('/api/sales',{...credit,creditDueDate:invalid},cashier);
    assert.equal(result.status,400,'invalid date '+invalid);
   }
   const past=await request('/api/sales',{...credit,creditDueDate:'2000-01-01'},cashier);
   assert.equal(past.status,409);assert.equal(past.body.error.code,'CREDIT_DUE_DATE_PAST');
   assert.equal(Number((await pool.query('SELECT count(*) n FROM customer_ledger WHERE organization_id=$1',[fixture.org])).rows[0].n),0,'invalid credit dates must not post ledger entries');
   const above=await request('/api/sales',{...credit,items:[{...credit.items[0],quantity:4}],payments:[],creditAmount:80000},cashier);assert.equal(above.status,409);assert.equal(above.body.error.code,'CREDIT_LIMIT_EXCEEDED');
   const saved=expectStatus(await request('/api/sales',credit,cashier),201).sale;assert.equal(Number(saved.total),20000);
   const ledger=(await pool.query('SELECT amount FROM customer_ledger WHERE sale_id=$1 AND entry_type=\'CREDIT_SALE\'',[saved.id])).rows;assert.equal(ledger.length,1);assert.equal(Number(ledger[0].amount),15000);
  });
  await t.test('branch RBAC, manager discount bound, closed shifts and measured stock',async()=>{
   assert.equal((await request('/api/sales',packet(0),second)).status,403);
   const high={...packet(0),items:[{...packet(0).items[0],unitPrice:8400}],payments:[{method:'cash',amount:8400}],metadata:{source:'pos-pro',cashTendered:8400}};const rejected=await request('/api/sales',high,cashier);assert.equal(rejected.status,409);assert.equal(rejected.body.error.code,'DISCOUNT_LIMIT_EXCEEDED');
   assert.equal((await request('/api/sales',packet(11),cashier)).status,409);
   for(const [index,quantity]of [[0,.001],[1,1.25],[2,2.5],[3,500],[4,1.5],[5,750]]){const saved=expectStatus(await request('/api/sales',packet(index,quantity),cashier),201).sale;assert.equal(saved.items[0].metadata.unit,fixture.products[index].unit);assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[fixture.products[index].id])).rows[0].quantity),fixture.products[index].stock-quantity)}
   assert.equal((await request('/api/shifts/'+shift.id+'/close',{actualCash:0},second)).status,403);
   expectStatus(await request('/api/shifts/'+shift.id+'/close',{actualCash:0},manager),200);assert.equal((await request('/api/sales',packet(9),cashier)).status,409);
  });
 }finally{await new Promise(r=>server.close(r));await pool.end()}
});
