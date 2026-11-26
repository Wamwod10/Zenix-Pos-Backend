import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {loyaltySpendStep,earnSaleLoyalty,reverseReturnedLoyalty} from '../src/services/customerLoyalty.js';
import {validateWorkspaceValues} from '../src/lib/settingsRevision.js';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const settings={workspaceSettings:{loyalty:{enabled:true,spendPerPoint:10000}}};
test('loyalty is opt-in, bounded, and requires a paid sale with a customer',async()=>{
 assert.equal(loyaltySpendStep({}),null);assert.equal(loyaltySpendStep(settings),10000);
 for(const spendPerPoint of [0,-1,0.5,'10000',1e10])assert.equal(loyaltySpendStep({workspaceSettings:{loyalty:{enabled:true,spendPerPoint}}}),null);
 assert.doesNotThrow(()=>validateWorkspaceValues(settings.workspaceSettings));
 assert.throws(()=>validateWorkspaceValues({loyalty:{enabled:'true',spendPerPoint:0}}));
 const client={query(){throw Error('ineligible sale must not write')}};
 await earnSaleLoyalty(client,{settings,creditAmount:1,customerId:'a'});
 await earnSaleLoyalty(client,{settings,creditAmount:0,customerId:null});
 await earnSaleLoyalty(client,{settings:{},creditAmount:0,customerId:'a'});
 await reverseReturnedLoyalty(client,{customerId:null});
});
const url=process.env.TEST_DATABASE_URL;
test('loyalty ledger accumulates once and reverses partial/full returns exactly',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);
 process.env.DATABASE_URL=url;
 const {pool}=await import('../src/db/pool.js');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const org=(await client.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Loyalty CI','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
  const store=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'A') RETURNING id",[org])).rows[0].id;
  const actor=(await client.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Loyalty CI',$2,'test','OWNER') RETURNING id",[org,randomUUID()])).rows[0].id;
  const customer=(await client.query("INSERT INTO customers(organization_id,name) VALUES($1,'Customer') RETURNING id",[org])).rows[0].id;
  const sale=(await client.query("INSERT INTO sales(organization_id,store_id,seller_id,customer_id,sale_number,total,subtotal) VALUES($1,$2,$3,$4,$5,35000,35000) RETURNING id",[org,store,actor,customer,randomUUID()])).rows[0].id;
  const args={organizationId:org,saleId:sale,actorId:actor,customerId:customer,settings,creditAmount:0};
  const entries=async()=>(await client.query('SELECT entry_type,points::text FROM customer_loyalty_ledger WHERE organization_id=$1 AND sale_id=$2 ORDER BY created_at,id',[org,sale])).rows;
  const points=async()=>Number((await client.query('SELECT COALESCE(sum(points),0) points FROM customer_loyalty_ledger WHERE organization_id=$1 AND sale_id=$2',[org,sale])).rows[0].points);
  await earnSaleLoyalty(client,args);await earnSaleLoyalty(client,args);assert.equal(await points(),3);assert.equal((await entries()).length,1);
  for(const [amount,expected] of [[5000,3],[12000,2],[24000,1],[35000,0]]){
   await client.query('UPDATE sales SET returned_amount=$2 WHERE id=$1',[sale,amount]);
   await reverseReturnedLoyalty(client,args);await reverseReturnedLoyalty(client,args);
   assert.equal(await points(),expected);
  }
  assert.equal((await entries()).length,4);
  const other=randomUUID();
  await earnSaleLoyalty(client,{...args,organizationId:other});
  await reverseReturnedLoyalty(client,{...args,organizationId:other});
  assert.equal(await points(),0);
 }finally{await client.query('ROLLBACK');client.release();await pool.end()}
});
