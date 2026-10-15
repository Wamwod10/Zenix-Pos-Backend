import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';

test('restock tool accepts only a nullable store scope',async()=>{
 if(process.env.AI_AGENT_TEST_DATABASE_URL){assertSafeTestDatabaseUrl(process.env.AI_AGENT_TEST_DATABASE_URL);process.env.DATABASE_URL=process.env.AI_AGENT_TEST_DATABASE_URL;process.env.NODE_ENV='test';}
 const {READ_REPORT_SCHEMAS}=await import('../src/services/aiReadReports.js');
 const {AGENT_TOOLS}=await import('../src/services/aiAgentRegistry.js');
 const schema=READ_REPORT_SCHEMAS.get_restock_advice;
 assert.ok(schema,'restock schema must be registered');
 assert.equal(schema.safeParse({storeId:null}).success,true);
 for(const args of [{},{storeId:'other'},{storeId:null,organizationId:'foreign'},{storeId:null,horizon:90}])assert.equal(schema.safeParse(args).success,false);
 const tool=AGENT_TOOLS.find(t=>t.name==='get_restock_advice');
 assert.equal(tool.strict,true);assert.equal(tool.parameters.additionalProperties,false);assert.deepEqual(tool.parameters.required,['storeId']);
});

const url=process.env.AI_AGENT_TEST_DATABASE_URL;
test('restock advice uses exact history and stock with live access boundaries',{skip:!url,timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url);process.env.NODE_ENV='test';process.env.DATABASE_URL=url;
 const {pool}=await import('../src/db/pool.js');
 const {executeAgentTool}=await import('../src/services/aiAgentRegistry.js');
 const context={settings:{enabled:true,writesEnabled:false},storeId:null};
 const orgs=[];
 const shift=(date,n)=>{const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
 async function fixture(){
  const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Restock test','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;orgs.push(org);
  const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Restock branch') RETURNING id",[org])).rows[0].id;
  const id=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Reader',$3,'test','OWNER') RETURNING id",[org,store,randomUUID()])).rows[0].id;
  const sessionId=(await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[id,randomUUID()])).rows[0].id;
  return {org,store,user:{id,organizationId:org,sessionId,storeId:store,appRole:'OWNER',permissionOverrides:{},rolePermissions:{}}};
 }
 try{
  const a=await fixture(),b=await fixture();
  const read=()=>executeAgentTool(a.user,'get_restock_advice',{storeId:a.store},context);
  const today=(await read()).report.to;
  for(const [name,unit,saleDays,stock] of [['Piece','piece',7,'0.1'],['Rice','kg',7,'0.123'],['Sparse','piece',2,'0'],['Unknown','box',7,'0']]){
   const product=(await pool.query("INSERT INTO products(organization_id,name,unit,created_at) VALUES($1,$2,$3,$4::date-40) RETURNING id",[a.org,name,unit,today])).rows[0].id;
   await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,$4)',[a.org,a.store,product,stock]);
   let sale;
   for(let i=0;i<saleDays;i++){
    sale=(await pool.query('INSERT INTO sales(organization_id,store_id,seller_id,sale_number,total,business_date) VALUES($1,$2,$3,$4,10,$5) RETURNING id',[a.org,a.store,a.user.id,randomUUID(),shift(today,-20+i)])).rows[0].id;
    await pool.query('INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total) VALUES($1,$2,$3,1,10,10)',[sale,product,name]);
   }
   if(name==='Rice')await pool.query('INSERT INTO sale_returns(organization_id,sale_id,store_id,product_id,quantity,amount,business_date) VALUES($1,$2,$3,$4,0.001,0.01,$5)',[a.org,sale,a.store,product,today]);
  }
  const snapshot=async()=>JSON.stringify((await pool.query('SELECT product_id,warehouse_id,quantity::text FROM warehouse_balances WHERE organization_id=$1 ORDER BY product_id,warehouse_id',[a.org])).rows);
  const before=await snapshot(),r=(await read()).report;
  await t.test('enough history rounds pieces and kg exactly; sparse and unknown units stay unknown',()=>{
   const rows=Object.fromEntries(r.tables[0].rows.map(row=>[row[0],row]));
   assert.equal(rows.Piece[5],'2');
   assert.equal(rows.Rice[2],'6.999');assert.equal(rows.Rice[5],'1.627');
   assert.equal(rows.Sparse[5],null);assert.equal(rows.Unknown[5],null);
   assert.equal(r.from,shift(today,-27));assert.match(r.notes.join(' '),/7 kunlik rejalashtirish/);
  });
  assert.equal(await snapshot(),before,'read must not mutate stock');
  await t.test('negative stock or net returns require a data check instead of numeric advice',async()=>{
   await pool.query("UPDATE inventory_balances SET quantity=-1 WHERE organization_id=$1 AND product_id=(SELECT id FROM products WHERE organization_id=$1 AND name='Piece')",[a.org]);
   await pool.query("UPDATE sale_returns SET quantity=8 WHERE organization_id=$1",[a.org]);
   const invalid=(await read()).report;
   const rows=Object.fromEntries(invalid.tables[0].rows.map(row=>[row[0],row]));
   assert.equal(rows.Piece[5],null);assert.equal(rows.Rice[5],null);
   assert.match(invalid.notes.join(' '),/manfiy.*tekshiring/);
  });
  await pool.query("UPDATE products SET created_at=now() WHERE organization_id=$1 AND name='Piece'",[a.org]);
  assert.equal((await read()).report.tables[0].rows.find(row=>row[0]==='Piece')[5],null,'new product cannot justify a numeric recommendation');
  await assert.rejects(()=>executeAgentTool(a.user,'get_restock_advice',{storeId:b.store},context),e=>e.code==='STORE_NOT_FOUND');
  await assert.rejects(()=>executeAgentTool(a.user,'get_restock_advice',{storeId:b.store},{...context,storeId:a.store}),e=>e.code==='STORE_FORBIDDEN');
  await pool.query("UPDATE users SET app_role='MANAGER' WHERE id=$1",[a.user.id]);a.user.appRole='MANAGER';
  for(const overrides of [{moduleInventory:false},{moduleDashboard:false,moduleHistory:false,moduleAnalytics:false,moduleSellerAnalytics:false}]){
   await pool.query('UPDATE users SET permission_overrides=$2 WHERE id=$1',[a.user.id,JSON.stringify(overrides)]);
   a.user.permissionOverrides=(await pool.query('SELECT permission_overrides FROM users WHERE id=$1',[a.user.id])).rows[0].permission_overrides;
   await assert.rejects(read,e=>e.code==='AI_FORBIDDEN');
  }
  await pool.query("UPDATE users SET permission_overrides='{}'::jsonb WHERE id=$1",[a.user.id]);
  a.user.permissionOverrides={};
  await pool.query("UPDATE users SET app_role='SALES',permission_overrides=$2 WHERE id=$1",[a.user.id,JSON.stringify({moduleInventory:true})]);
  a.user.appRole='SALES';a.user.permissionOverrides={moduleInventory:true};
  const sellerReport=(await executeAgentTool(a.user,'get_restock_advice',{storeId:null},context)).report;
  assert.equal(sellerReport.storeId,a.store);assert.equal(sellerReport.sellerScoped,true);
  await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[a.user.sessionId]);
  await assert.rejects(read,e=>e.code==='AI_ACCESS_CHANGED');
 }finally{
  for(const org of orgs){
   await pool.query('DELETE FROM sale_returns WHERE organization_id=$1',[org]);
   await pool.query('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=$1)',[org]);
   for(const table of ['sales','users','products','stores','organizations'])await pool.query(`DELETE FROM ${table} WHERE ${table==='organizations'?'id':'organization_id'}=$1`,[org]);
  }
  await pool.end();
 }
});
