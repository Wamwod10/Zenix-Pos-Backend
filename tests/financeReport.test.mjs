import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertSafeTestDatabaseUrl } from '../scripts/assertTestDatabase.js';

test('finance report keeps revenue date separate from refund cashflow and paginates past 3000', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
  assert.equal(process.env.NODE_ENV,'test');
  const db=new pg.Client({connectionString:url});
  await db.connect();
  await db.query('BEGIN');
  try {
    const {financeReport,shiftSalesStats}=await import('../src/services/financeReport.js');
    const org=(await db.query("INSERT INTO organizations(name,timezone) VALUES('Finance fixture','Asia/Tashkent') RETURNING id")).rows[0].id;
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Fixture') RETURNING id",[org])).rows[0].id;
    const user=(await db.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Actor',gen_random_uuid()::text,'unused','OWNER') RETURNING id",[org,store])).rows[0].id;
    const product=(await db.query("INSERT INTO products(organization_id,name) VALUES($1,'Fixture product') RETURNING id",[org])).rows[0].id;
    const a=(await db.query("INSERT INTO shifts(organization_id,store_id,cashier_id,status,opening_cash,expected_cash,actual_cash,closed_at) VALUES($1,$2,$3,'closed',0,100000,100000,now()) RETURNING id",[org,store,user])).rows[0].id;
    const b=(await db.query("INSERT INTO shifts(organization_id,store_id,cashier_id,opening_cash) VALUES($1,$2,$3,100000) RETURNING id",[org,store,user])).rows[0].id;
    const sale=(await db.query("INSERT INTO sales(organization_id,store_id,shift_id,seller_id,sale_number,total,returned_amount,business_date,created_at) VALUES($1,$2,$3,$4,'A',100000,40000,'2026-10-08','2026-10-08T18:59:00Z') RETURNING id",[org,store,a,user])).rows[0].id;
    await db.query("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total,metadata) VALUES($1,$2,'Fixture product',1,100000,100000,'{\"unitCost\":50000}')",[sale,product]);
    await db.query("INSERT INTO sale_payments(sale_id,method,amount) VALUES($1,'cash',100000)",[sale]);
    await db.query("INSERT INTO sale_returns(organization_id,store_id,sale_id,product_id,quantity,amount,business_date,created_by,metadata,created_at) VALUES($1,$2,$3,$4,0.4,40000,'2026-10-09',$5,$6,'2026-10-08T19:01:00Z')",[org,store,sale,product,user,JSON.stringify({refundShiftId:b,refundBreakdown:{cash:40000},unitCost:50000})]);
    await db.query("INSERT INTO shift_movements(organization_id,shift_id,type,amount,source,created_by) VALUES($1,$2,'out',40000,'return-adjustment',$3)",[org,b,user]);
    const before=await financeReport(db,{organizationId:org,from:'2026-10-08',to:'2026-10-08'});
    assert.equal(before.aggregate.grossRevenue,100000);
    assert.equal(before.aggregate.netRevenue,100000);
    assert.equal(before.aggregate.cashflow.cash,100000);
    assert.equal(before.aggregate.grossProfit,50000);
    const after=await financeReport(db,{organizationId:org,from:'2026-10-09',to:'2026-10-09'});
    assert.equal(after.aggregate.netRevenue,-40000);
    assert.equal(after.aggregate.cashflow.cash,-40000);
    assert.equal(after.aggregate.grossProfit,-20000);
    assert.equal(after.returns[0].createdBy,user);
    assert.equal(after.returns[0].refundShiftId,b);
    assert.equal((await shiftSalesStats(db,org,store)).get(a).cashSales,100000);
    assert.equal((await db.query('SELECT expected_cash FROM shifts WHERE id=$1',[a])).rows[0].expected_cash,'100000.00');
    assert.equal((await financeReport(db,{organizationId:org})).aggregate.lifetimeNetRevenue,60000);
    for(const [number,total,payments,amount,breakdown] of [
      ['card',100000,{card:100000},25000,{cash:25000}],
      ['split',100000,{cash:20000,card:30000,credit:50000},20000,{cash:10000,card:10000}],
      ['credit',80000,{credit:80000},30000,{credit:30000}],
    ]){
      const id=(await db.query("INSERT INTO sales(organization_id,store_id,shift_id,seller_id,sale_number,total,returned_amount,business_date) VALUES($1,$2,$3,$4,$5,$6,$7,'2026-10-10') RETURNING id",[org,store,b,user,number,total,amount])).rows[0].id;
      for(const [method,paid] of Object.entries(payments))await db.query('INSERT INTO sale_payments(sale_id,method,amount) VALUES($1,$2,$3)',[id,method,paid]);
      await db.query("INSERT INTO sale_returns(organization_id,store_id,sale_id,product_id,quantity,amount,business_date,created_by,metadata) VALUES($1,$2,$3,$4,0.1,$5,'2026-10-11',$6,$7)",[org,store,id,product,amount,user,JSON.stringify({refundShiftId:b,refundBreakdown:breakdown})]);
    }
    const captures=await financeReport(db,{organizationId:org,from:'2026-10-10',to:'2026-10-10'});
    assert.equal(captures.aggregate.netRevenue,280000);
    assert.deepEqual(captures.aggregate.cashflow,{cash:20000,card:130000,transfer:0});
    const refundMethods=await financeReport(db,{organizationId:org,from:'2026-10-11',to:'2026-10-11'});
    assert.equal(refundMethods.aggregate.netRevenue,-75000);
    assert.deepEqual(refundMethods.aggregate.cashflow,{cash:-35000,card:-10000,transfer:0});
    assert.equal((await financeReport(db,{organizationId:org,from:'2026-10-10',to:'2026-10-10',paymentMethod:'split'})).aggregate.saleCount,1);
    assert.equal((await financeReport(db,{organizationId:org,search:'Fixture product',from:'2026-10-08',to:'2026-10-08'})).aggregate.saleCount,1);
    await db.query("INSERT INTO expenses(organization_id,store_id,title,amount,created_at) VALUES($1,$2,'Timezone edge',123,'2026-10-08T19:01:00Z')",[org,store]);
    const expenseDay=await financeReport(db,{organizationId:org,from:'2026-10-09',to:'2026-10-09'});
    assert.equal(expenseDay.aggregate.expenseTotal,123);
    assert.equal(expenseDay.expenses[0].dateISO,'2026-10-09');
    assert.equal((await financeReport(db,{organizationId:org,from:'2026-10-08',to:'2026-10-08'})).aggregate.expenseTotal,0);
    await db.query("INSERT INTO sales(organization_id,store_id,seller_id,sale_number,total,business_date) SELECT $1,$2,$3,'many-'||i,1,'2026-10-08' FROM generate_series(1,3001) i",[org,store,user]);
    const all=await financeReport(db,{organizationId:org,from:'2026-10-08',to:'2026-10-09',limit:2,offset:3000});
    assert.equal(all.aggregate.saleCount,3002);
    assert.equal(all.aggregate.netRevenue,63001);
    assert.equal(all.sales.length,2);
    assert.equal(all.pagination.total,3002);
    assert.equal((await financeReport(db,{organizationId:org,storeId:'00000000-0000-0000-0000-000000000000'})).aggregate.saleCount,0);
  } finally {await db.query('ROLLBACK');await db.end();}
});
