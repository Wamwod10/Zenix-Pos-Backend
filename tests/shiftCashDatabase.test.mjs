import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {shiftCashSummary,shiftExpectedCash} from '../src/lib/shiftCash.js';

const url=process.env.TEST_DATABASE_URL;
test('full PostgreSQL shift cash is independent of bootstrap limits',{skip:!url},async t=>{
  assertSafeTestDatabaseUrl(url);
  const client=new pg.Client({connectionString:url});await client.connect();
  try{
    await client.query('BEGIN');
    const org=(await client.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('SHIFT01 disposable test','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
    const store=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'SHIFT01 branch') RETURNING id",[org])).rows[0].id;
    const cashier=(await client.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'SHIFT01 cashier',$3,'test-only','CASHIER') RETURNING id",[org,store,randomUUID()])).rows[0].id;
    for(const count of [1,100,3000,5000,10000])await t.test(`${count} mixed-payment sales plus refunds, expenses, supplier, customer, manual cash`,async caseTest=>{
      const seedStarted=performance.now();
      const shift=(await client.query("INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,opening_cash,status) VALUES($1,$2,$3,$4,0.10,'closed') RETURNING *",[org,store,cashier,randomUUID()])).rows[0];
      await client.query(`WITH inserted AS (
        INSERT INTO sales(organization_id,store_id,shift_id,seller_id,sale_number,total,returned_amount)
        SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$3::uuid::text||'-'||n,20.06,CASE WHEN n=1 THEN 1.01 ELSE 0 END
        FROM generate_series(1,$5::int) n RETURNING id
      ) INSERT INTO sale_payments(sale_id,method,amount)
        SELECT id,p.method,p.amount FROM inserted
        CROSS JOIN (VALUES ('cash',10.01::numeric),('card',7.02::numeric),('transfer',3.03::numeric)) p(method,amount)`,[org,store,shift.id,cashier,count]);
      await client.query(`INSERT INTO shift_movements(organization_id,shift_id,type,amount,source,reason,created_by)
        SELECT $1,$2,p.type,p.amount,p.source,'SHIFT01 fixture',$3 FROM
        (VALUES ('out',1.01::numeric,'refund'),('out',2.02::numeric,'expense'),('out',3.03::numeric,'supplier_payment'),
          ('in',4.04::numeric,'customer_payment'),('in',5.05::numeric,'manual'),('out',6.06::numeric,'manual')) p(type,amount,source)`,[org,shift.id,cashier]);
      const seedMs=performance.now()-seedStarted;
      const queryStarted=performance.now();
      const summary=await shiftCashSummary(client,shift);
      caseTest.diagnostic(`fixture ${seedMs.toFixed(1)}ms; authoritative summary ${(performance.now()-queryStarted).toFixed(1)}ms`);
      const expected=Number(BigInt(count)*1001n+10n+909n-1212n)/100;
      assert.deepEqual(summary,{openingCash:0.1,cashSales:Number(BigInt(count)*1001n)/100,cashIn:9.09,cashOut:12.12,expectedCash:expected});
      assert.equal(await shiftExpectedCash(client,shift),expected);
      const independent=(await client.query(`SELECT $2::numeric +
        (SELECT sum(amount) FROM sale_payments WHERE sale_id IN (SELECT id FROM sales WHERE shift_id=$1) AND method='cash') +
        (SELECT sum(CASE WHEN type='in' THEN amount ELSE -amount END) FROM shift_movements WHERE shift_id=$1) expected`,[shift.id,shift.opening_cash])).rows[0];
      assert.equal(summary.expectedCash,Number(independent.expected));
    });
  }finally{await client.query('ROLLBACK');await client.end()}
});
