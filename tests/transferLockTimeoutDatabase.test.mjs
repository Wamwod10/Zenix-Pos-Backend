import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';

const {Client}=pg;
const url=process.env.TEST_DATABASE_URL;

// Runs only against a disposable CI/test database, after full migrations.
// The two PostgreSQL sessions intentionally contend on the same stock row.
test('PostgreSQL concurrent inventory row lock_timeout aborts losing transaction without stock mutation',
  {skip:!url,timeout:20000},async()=>{
    assertSafeTestDatabaseUrl(url);
    assert.equal(process.env.NODE_ENV,'test');
    assert.equal(process.env.DATABASE_URL,url);
    const writer=new Client({connectionString:url}),contender=new Client({connectionString:url});
    await writer.connect();await contender.connect();
    let writerActive=false,contenderActive=false;
    try{
      const org=(await writer.query(
        "INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES($1,'ACTIVE',CURRENT_DATE+30,1) RETURNING id",
        ['Lock-timeout test '+randomUUID()]
      )).rows[0].id;
      const store=(await writer.query(
        "INSERT INTO stores(organization_id,name) VALUES($1,'Lock-Test') RETURNING id",[org]
      )).rows[0].id;
      const product=(await writer.query(
        "INSERT INTO products(organization_id,name,unit) VALUES($1,$2,'dona') RETURNING id",
        [org,'Lock product '+randomUUID()]
      )).rows[0].id;
      const key=[org,store,product],selector='organization_id=$1 AND store_id=$2 AND product_id=$3';
      await writer.query(
        'INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,10,12000)',key
      );
      const before=(await writer.query(
        `SELECT quantity::text,avg_cost::text,version FROM inventory_balances WHERE ${selector}`,key
      )).rows[0];

      await writer.query('BEGIN');writerActive=true;
      const locked=await writer.query(`SELECT quantity FROM inventory_balances WHERE ${selector} FOR UPDATE`,key);
      assert.equal(locked.rowCount,1);
      await contender.query('BEGIN');contenderActive=true;
      await contender.query("SET LOCAL lock_timeout = '250ms'");
      await assert.rejects(
        contender.query(`SELECT quantity FROM inventory_balances WHERE ${selector} FOR UPDATE`,key),
        error=>error?.code==='55P03',
        'The second real PG session must reject lock acquisition with 55P03, not silently proceed'
      );
      await contender.query('ROLLBACK');contenderActive=false;
      await writer.query('COMMIT');writerActive=false;
      const after=(await writer.query(
        `SELECT quantity::text,avg_cost::text,version FROM inventory_balances WHERE ${selector}`,key
      )).rows[0];
      assert.deepEqual(after,before,'lock timeout must not change inventory quantity, cost or version');
    }finally{
      if(contenderActive)await contender.query('ROLLBACK').catch(()=>{});
      if(writerActive)await writer.query('ROLLBACK').catch(()=>{});
      await Promise.all([writer.end(),contender.end()]);
    }
  }
);
