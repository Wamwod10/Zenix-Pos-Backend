import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {financeReport} from '../src/services/financeReport.js';
const url=process.env.TEST_DATABASE_URL;
test('expense report periods use each branch business-day cutoff',{skip:!url},async()=>{
  assertSafeTestDatabaseUrl(url);
  const client=new pg.Client({connectionString:url});await client.connect();
  try{
    await client.query('BEGIN');
    const org=(await client.query("INSERT INTO organizations(name,timezone,license_status,expiry_date,store_limit) VALUES('Branch expense date test','Asia/Tashkent','ACTIVE','2099-01-01',2) RETURNING id")).rows[0].id;
    const stores=[];for(const name of ['Override','Global'])stores.push((await client.query('INSERT INTO stores(organization_id,name) VALUES($1,$2) RETURNING id',[org,name])).rows[0].id);
    await client.query('UPDATE organizations SET settings=$2 WHERE id=$1',[org,{workspaceSettings:{businessDay:{startTime:'00:00'},storeOverrides:{[stores[0]]:{businessDay:{startTime:'08:00'}}}}}]);
    await client.query(`INSERT INTO expenses(organization_id,store_id,title,amount,payment_method,created_at) VALUES
      ($1,$2,'Before branch cutoff',10.01,'card','2026-10-25T01:00:00Z'),
      ($1,$2,'After branch cutoff',20.02,'card','2026-10-25T04:00:00Z'),
      ($1,$3,'Global midnight cutoff',30.03,'card','2026-10-25T01:00:00Z')`,[org,...stores]);
    const previous=await financeReport(client,{organizationId:org,from:'2026-10-24',to:'2026-10-24'});
    assert.equal(previous.aggregate.expenseTotal,10.01);assert.equal(previous.expenses[0].businessDateISO,'2026-10-24');
    const current=await financeReport(client,{organizationId:org,from:'2026-10-25',to:'2026-10-25'});
    assert.equal(current.aggregate.expenseTotal,50.05);assert.equal(current.expenses.length,2);
    const scoped=await financeReport(client,{organizationId:org,storeId:stores[0],from:'2026-10-25',to:'2026-10-25'});
    assert.equal(scoped.aggregate.expenseTotal,20.02);
  }finally{await client.query('ROLLBACK');await client.end()}
});
