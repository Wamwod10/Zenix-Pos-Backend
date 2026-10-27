import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';

test('seller-filtered finance nets cross-operator refunds against the original seller, keeping refund actor audit',
  {skip:!process.env.TEST_DATABASE_URL,timeout:30000},async()=>{
    const url=process.env.TEST_DATABASE_URL;
    assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
    assert.equal(process.env.NODE_ENV,'test');
    assert.equal(process.env.DATABASE_URL,url);
    const db=new pg.Client({connectionString:url});
    await db.connect();
    await db.query('BEGIN');
    try{
      const {financeReport}=await import('../src/services/financeReport.js');
      const org=(await db.query("INSERT INTO organizations(name,timezone,license_status,expiry_date) VALUES($1,'Asia/Tashkent','ACTIVE',CURRENT_DATE+30) RETURNING id",['Seller attribution '+randomUUID()])).rows[0].id;
      const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Seller report branch') RETURNING id",[org])).rows[0].id;
      const addUser=async(name)=>(await db.query(
        "INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,$3,$4,'unused','CASHIER') RETURNING id",
        [org,store,name,randomUUID()]
      )).rows[0].id;
      const seller=await addUser('Original seller');
      const refundActor=await addUser('Different refund operator');
      const product=(await db.query("INSERT INTO products(organization_id,name) VALUES($1,'Attribution product') RETURNING id",[org])).rows[0].id;
      const sale=(await db.query(
        "INSERT INTO sales(organization_id,store_id,seller_id,sale_number,total,returned_amount,business_date) VALUES($1,$2,$3,$4,2000,2000,'2026-10-28') RETURNING id",
        [org,store,seller,'ATTR-'+randomUUID()]
      )).rows[0].id;
      await db.query("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total,metadata) VALUES($1,$2,'Attribution product',1,2000,2000,$3)",[sale,product,JSON.stringify({unitCost:1000})]);
      await db.query("INSERT INTO sale_payments(sale_id,method,amount) VALUES($1,'cash',2000)",[sale]);
      await db.query(
        "INSERT INTO sale_returns(organization_id,store_id,sale_id,product_id,quantity,amount,business_date,created_by,metadata) VALUES($1,$2,$3,$4,1,2000,'2026-10-28',$5,$6)",
        [org,store,sale,product,refundActor,JSON.stringify({unitCost:1000,refundBreakdown:{cash:2000}})]
      );
      const expenseAccess={details:false,aggregate:false};
      const sellerReport=await financeReport(db,{organizationId:org,storeId:store,sellerId:seller,from:'2026-10-28',to:'2026-10-28',expenseAccess});
      assert.equal(sellerReport.aggregate.saleCount,1);
      assert.equal(sellerReport.aggregate.returnCount,1);
      assert.equal(sellerReport.aggregate.grossRevenue,2000);
      assert.equal(sellerReport.aggregate.refundAmount,2000);
      assert.equal(sellerReport.aggregate.netRevenue,0);
      assert.equal(sellerReport.aggregate.grossProfit,0);
      assert.equal(sellerReport.returns.length,1);
      assert.equal(sellerReport.returns[0].createdBy,refundActor,'The refund actor must remain auditable independently of sale attribution');
      assert.equal(sellerReport.returns[0].sourceSale.sellerId,seller);

      const performerReport=await financeReport(db,{organizationId:org,storeId:store,sellerId:refundActor,from:'2026-10-28',to:'2026-10-28',expenseAccess});
      assert.equal(performerReport.aggregate.saleCount,0);
      assert.equal(performerReport.aggregate.returnCount,0);
      assert.equal(performerReport.aggregate.netRevenue,0);
      assert.equal(performerReport.aggregate.grossProfit,0);

      const organizationReport=await financeReport(db,{organizationId:org,storeId:store,from:'2026-10-28',to:'2026-10-28',expenseAccess});
      assert.equal(organizationReport.aggregate.returnCount,1);
      assert.equal(organizationReport.aggregate.netRevenue,0);
      assert.equal(organizationReport.aggregate.grossProfit,0);
    }finally{
      await db.query('ROLLBACK').catch(()=>{});
      await db.end();
    }
  }
);
