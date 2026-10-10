import test from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';import {buildCustomerPageQuery} from '../src/services/customerDirectory.js';
const url=process.env.TEST_DATABASE_URL;
(url?test:test.skip)('10000 customers and sales directory is bounded and tenant-isolated',{timeout:30000},async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const pool=new pg.Pool({connectionString:url});const client=await pool.connect();
 try{await client.query('BEGIN');const org=(await client.query("INSERT INTO organizations(name) VALUES('Performance test only') RETURNING id")).rows[0].id;
 const store=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'Benchmark') RETURNING id",[org])).rows[0].id;
 await client.query("INSERT INTO customers(organization_id,name,phone) SELECT $1,'Customer '||n,'998'||lpad(n::text,9,'0') FROM generate_series(1,10000) n",[org]);
 await client.query("INSERT INTO sales(organization_id,store_id,customer_id,sale_number,subtotal,total) SELECT $1,$2,id,'BENCH-'||id,100,100 FROM customers WHERE organization_id=$1",[org,store]);
 await client.query("INSERT INTO customer_ledger(organization_id,store_id,customer_id,entry_type,amount) SELECT $1,$2,id,'CREDIT_SALE',10 FROM customers WHERE organization_id=$1",[org,store]);
 const query=buildCustomerPageQuery({organizationId:org,filter:'debtors',sort:'spend',limit:100});const start=performance.now();const result=await client.query(query.text,query.values);const elapsed=performance.now()-start;
 assert.equal(result.rows.length,100);assert.equal(Number(result.rows[0].total),10000);assert.ok(result.rows.every(row=>row.organization_id===org));assert.ok(elapsed<5000,`${elapsed}ms`);console.log(`CRM 10000 customers / 10000 sales: ${Math.round(elapsed)}ms, 100-row page`);
 }finally{await client.query('ROLLBACK');client.release();await pool.end()}
});
