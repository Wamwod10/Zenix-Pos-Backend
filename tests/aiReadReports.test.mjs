import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';

test('read analytics schemas reject invalid, unbounded and extra arguments',async()=>{
 const {READ_REPORT_SCHEMAS:s}=await import('../src/services/aiReadReports.js');
 const dates={storeId:null,from:'2026-01-01',to:'2026-01-31',comparisonFrom:'2025-12-01',comparisonTo:'2025-12-31'};
 assert.equal(s.compare_sales_periods.safeParse(dates).success,true);
 for(const extra of [{from:'2026-02-30'},{to:'2025-01-01'},{from:'2020-01-01'},{organizationId:randomUUID()}])assert.equal(s.compare_sales_periods.safeParse({...dates,...extra}).success,false);
 assert.equal(s.get_product_sales_report.safeParse({storeId:null,ranking:'slow',from:null,to:'2026-01-31'}).success,false);
 assert.equal(s.get_warehouse_summary.safeParse({storeId:null,sql:'SELECT 1'}).success,false);
 assert.equal(s.get_business_overview.safeParse({storeId:null,organizationId:randomUUID()}).success,false);
});

const url=process.env.AI_AGENT_TEST_DATABASE_URL;
test('read tools aggregate exact tenant, warehouse and seller scoped facts on disposable PostgreSQL',{skip:!url,timeout:60000},async t=>{
 assertSafeTestDatabaseUrl(url);process.env.NODE_ENV='test';process.env.DATABASE_URL=url;
 const {pool}=await import('../src/db/pool.js');
 const {executeAgentTool}=await import('../src/services/aiAgentRegistry.js');
 const context={settings:{enabled:true,writesEnabled:false},storeId:null};
 const fixtures=[];
 async function fixture(){
  const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Read analytics test','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;fixtures.push(org);
  const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Read branch') RETURNING id",[org])).rows[0].id;
  const warehouse=(await pool.query('SELECT id FROM warehouses WHERE organization_id=$1 AND store_id=$2',[org,store])).rows[0].id;
  const uid=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Reader',$3,'test','OWNER') RETURNING id",[org,store,randomUUID()])).rows[0].id;
  const session=(await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id",[uid,randomUUID()])).rows[0].id;
  const products=[];
  for(const [name,unit] of [['Rice','kg'],['Water','piece']])products.push((await pool.query('INSERT INTO products(organization_id,name,unit,min_stock) VALUES($1,$2,$3,1) RETURNING id',[org,name,unit])).rows[0].id);
  for(const product of products)await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,10)',[org,store,product]);
  const user={id:uid,organizationId:org,sessionId:session,storeId:store,appRole:'OWNER',permissionOverrides:{},rolePermissions:{}};
  return {user,org,store,warehouse,products};
 }
 const facts=r=>Object.fromEntries(r.report.facts.map(f=>[f.id,f.value]));
 try{
  const a=await fixture(),b=await fixture();
  await t.test('one overview combines authorized facts with explicit periods and no invented total profit',async()=>{
   const report=(await executeAgentTool(a.user,'get_business_overview',{storeId:a.store},context)).report;
   assert.equal(report.topic,'business_overview');assert.equal(report.storeId,a.store);
   assert.ok(report.facts.some(f=>f.id==='today_sales_sales_count'));
   assert.ok(report.facts.some(f=>f.id==='inventory_warehouse_catalog_products'));
   assert.ok(report.facts.every(f=>f.from&&f.to));assert.equal(new Set(report.facts.map(f=>f.id)).size,report.facts.length);
   assert.ok(!report.facts.some(f=>f.id==='total_profit'));
   const sale=(await pool.query('INSERT INTO sales(organization_id,store_id,seller_id,sale_number,total,business_date) VALUES($1,$2,$3,$4,200,$5) RETURNING id',[a.org,a.store,a.user.id,randomUUID(),report.to])).rows[0].id;
   await pool.query(`INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total,metadata) VALUES($1,$2,'Rice',2,100,200,'{"unitCost":50}')`,[sale,a.products[0]]);
   const live=(await executeAgentTool(a.user,'get_business_overview',{storeId:a.store},context)).report;
   assert.equal(live.facts.find(f=>f.id==='today_sales_today_net').value,'200.00');
   const profit=live.facts.find(f=>f.id==='profit_profit_0');assert.equal(profit.value,'100.00');assert.match(profit.label,/Rice/);assert.notEqual(profit.from,report.to);
   await assert.rejects(()=>executeAgentTool(a.user,'get_business_overview',{storeId:b.store},context),e=>e.code==='STORE_NOT_FOUND');
  });
  await t.test('catalog, available and low stock are independent, including zero low stock',async()=>{
   const r=await executeAgentTool(a.user,'get_warehouse_summary',{storeId:null},context),f=facts(r);
   assert.equal(f.warehouse_catalog_products,'2');assert.equal(f.warehouse_available_products,'2');assert.equal(f.warehouse_low_stock_count,'0');assert.equal(f.warehouse_count,'1');assert.equal(f.warehouse_store_count,'1');
   assert.equal(new Set(r.report.facts.map(f=>f.id)).size,r.report.facts.length);
   assert.ok(!r.report.facts.some(f=>f.id.includes('quantity')));
   await pool.query('UPDATE inventory_balances SET quantity=0 WHERE organization_id=$1 AND product_id=$2',[a.org,a.products[0]]);
   const low=facts(await executeAgentTool(a.user,'get_warehouse_summary',{storeId:a.store},context));
   assert.equal(low.warehouse_catalog_products,'2');assert.equal(low.warehouse_available_products,'1');assert.equal(low.warehouse_low_stock_count,'1');
   await pool.query('UPDATE inventory_balances SET quantity=10 WHERE organization_id=$1 AND product_id=$2',[a.org,a.products[0]]);
  });
  let sale;
  await t.test('period comparison deducts dated returns and computes exact decimal deltas',async()=>{
   for(const [day,total] of [['2026-01-02','90071992547409.91'],['2026-02-02','90071992547410.03']]){
    sale=(await pool.query('INSERT INTO sales(organization_id,store_id,seller_id,sale_number,total,business_date) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[a.org,a.store,a.user.id,randomUUID(),total,day])).rows[0].id;
    await pool.query("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total) VALUES($1,$2,'Rice',2,10,20)",[sale,a.products[0]]);
   }
   await pool.query("INSERT INTO sale_returns(organization_id,sale_id,store_id,product_id,quantity,amount,business_date) VALUES($1,$2,$3,$4,1,0.03,'2026-02-03')",[a.org,sale,a.store,a.products[0]]);
   const f=facts(await executeAgentTool(a.user,'compare_sales_periods',{storeId:null,from:'2026-02-01',to:'2026-02-28',comparisonFrom:'2026-01-01',comparisonTo:'2026-01-31'},context));
   assert.equal(f.period_current_net,'90071992547410.00');assert.equal(f.period_current_refunds,'0.03');assert.equal(f.period_delta_net,'0.09');
  });
  await t.test('bounded slow products includes unsold catalog without inferring causes',async()=>{
   const r=await executeAgentTool(a.user,'get_product_sales_report',{storeId:null,ranking:'slow',from:'2026-02-01',to:'2026-02-28'},context);
   assert.equal(r.report.tables[0].rows[0][0],'Water');assert.equal(facts(r).product_sales_0_quantity,'0');
   assert.equal(r.report.tables[0].rows[1][2],'1.000');
  });
  await t.test('tenant, conversation, permissions and live session boundaries are enforced',async()=>{
   await assert.rejects(()=>executeAgentTool(a.user,'get_warehouse_summary',{storeId:b.store},context),e=>e.code==='STORE_NOT_FOUND');
   await assert.rejects(()=>executeAgentTool(a.user,'get_warehouse_summary',{storeId:b.store},{...context,storeId:a.store}),e=>e.code==='STORE_FORBIDDEN');
   await pool.query("UPDATE users SET app_role='SALES' WHERE id=$1",[a.user.id]);
   const seller={...a.user,appRole:'SALES'};
   const overview=(await executeAgentTool(seller,'get_business_overview',{storeId:null},context)).report;
   assert.equal(overview.sellerScoped,true);assert.equal(overview.storeId,a.store);assert.ok(overview.facts.every(f=>f.id.startsWith('today_sales_')));
   await assert.rejects(()=>executeAgentTool(seller,'get_warehouse_summary',{storeId:null},context),e=>e.code==='AI_FORBIDDEN');
   await assert.rejects(()=>executeAgentTool(seller,'compare_sales_periods',{storeId:b.store,from:'2026-02-01',to:'2026-02-28',comparisonFrom:'2026-01-01',comparisonTo:'2026-01-31'},context),e=>e.code==='STORE_FORBIDDEN');
   const r=await executeAgentTool(seller,'get_product_sales_report',{storeId:null,ranking:'top',from:'2026-02-01',to:'2026-02-28'},context);assert.equal(r.report.sellerScoped,true);assert.equal(r.report.storeId,a.store);
   await pool.query("INSERT INTO sales(organization_id,store_id,sale_number,total,business_date) VALUES($1,$2,$3,100,'2026-02-02')",[a.org,a.store,randomUUID()]);
   const comparison=facts(await executeAgentTool(seller,'compare_sales_periods',{storeId:null,from:'2026-02-01',to:'2026-02-28',comparisonFrom:'2026-01-01',comparisonTo:'2026-01-31'},context));
   assert.equal(comparison.period_current_count,'1');assert.equal(comparison.period_current_net,'90071992547410.00');
   await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[seller.sessionId]);
   await assert.rejects(()=>executeAgentTool(seller,'get_product_sales_report',{storeId:null,ranking:'top',from:null,to:null},context),e=>e.code==='AI_ACCESS_CHANGED');
   await pool.query("UPDATE organizations SET plan_code='START' WHERE id=$1",[b.org]);
   await assert.rejects(()=>executeAgentTool(b.user,'get_warehouse_summary',{storeId:null},context),e=>e.code==='AI_PLAN_REQUIRED');
  });
 }finally{
  for(const org of fixtures){
   await pool.query('DELETE FROM sale_returns WHERE organization_id=$1',[org]);
   await pool.query('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=$1)',[org]);
   await pool.query('DELETE FROM sales WHERE organization_id=$1',[org]);
   await pool.query('DELETE FROM users WHERE organization_id=$1',[org]);
   await pool.query('DELETE FROM products WHERE organization_id=$1',[org]);
   await pool.query('DELETE FROM stores WHERE organization_id=$1',[org]);
   await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
  }
  await pool.end();
 }
});
