// Read benchmark plus rollback-only edge fixtures, strictly disposable loopback.
import assert from 'node:assert/strict';
import pg from 'pg';
import {performance} from 'node:perf_hooks';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
const target=assertSafeTestDatabaseUrl(url);
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55436');assert.equal(target.pathname,'/zenix_perf_test');
const baseline=branch=>`SELECT p.*,
 COALESCE(jsonb_object_agg(ib.store_id,ib.quantity) FILTER (WHERE ib.store_id IS NOT NULL),'{}'::jsonb) AS stock_by_store,
 max(ls.last_sale_at) AS last_sale_at
 FROM products p
 LEFT JOIN inventory_balances ib ON ib.product_id=p.id AND ib.organization_id=p.organization_id ${branch?'AND ib.store_id=$2':''}
 LEFT JOIN (
 SELECT si.product_id,max(s.created_at) AS last_sale_at FROM sale_items si JOIN sales s ON s.id=si.sale_id
 WHERE s.organization_id=$1 ${branch?'AND s.store_id=$2':''} GROUP BY si.product_id
 ) ls ON ls.product_id=p.id
 WHERE p.organization_id=$1 GROUP BY p.id ORDER BY p.created_at`;
const candidate=branch=>`SELECT p.*,COALESCE(ib.stock_by_store,'{}'::jsonb) AS stock_by_store,ls.last_sale_at
 FROM products p
 LEFT JOIN (
 SELECT product_id,jsonb_object_agg(store_id,quantity) AS stock_by_store
 FROM inventory_balances WHERE organization_id=$1 ${branch?'AND store_id=$2':''} GROUP BY product_id
 ) ib ON ib.product_id=p.id
 LEFT JOIN (
 SELECT si.product_id,max(s.created_at) AS last_sale_at FROM sale_items si JOIN sales s ON s.id=si.sale_id
 WHERE s.organization_id=$1 ${branch?'AND s.store_id=$2':''} GROUP BY si.product_id
 ) ls ON ls.product_id=p.id
 WHERE p.organization_id=$1 ORDER BY p.created_at`;
const pool=new pg.Pool({connectionString:url,max:1}),db=await pool.connect();
const report={cases:[]};
const sorted=rows=>rows.toSorted((a,b)=>a.id.localeCompare(b.id));
const stats=values=>{const v=values.toSorted((a,b)=>a-b);return {n:v.length,p50:v[Math.ceil(v.length*.5)-1],p95:v[Math.ceil(v.length*.95)-1],samples:values}};
const assertEquivalent=async(org,stores)=>{
 for(const store of [null,...stores]){
  const args=store?[org,store]:[org];
  const before=(await db.query(baseline(Boolean(store)),args)).rows,after=(await db.query(candidate(Boolean(store)),args)).rows;
  assert.deepEqual(sorted(after),sorted(before));
  for(let i=1;i<after.length;i++)assert.ok(after[i-1].created_at<=after[i].created_at,'created_at ordering retained');
 }
};
try{
 const fixture=(await db.query("SELECT organization_id,count(*)::int n FROM products GROUP BY organization_id HAVING count(*)>=50000 ORDER BY count(*) DESC LIMIT 1")).rows[0];
 assert.ok(fixture,'50k populated fixture required');
 const stores=(await db.query('SELECT id FROM stores WHERE organization_id=$1 ORDER BY id',[fixture.organization_id])).rows.map(r=>r.id);
 assert.ok(stores.length>=2);report.products=fixture.n;
 report.environment=(await db.query("SELECT version(),current_setting('work_mem') work_mem")).rows[0];
 await assertEquivalent(fixture.organization_id,stores);
 report.populatedEquivalence='all fields, exact stock JSON/numeric values, last sale and created_at order: owner and each branch';
 for(const store of [null,stores[0]]){
  const args=store?[fixture.organization_id,store]:[fixture.organization_id];
  const row={scope:store?'branch':'owner',baseline:[],candidate:[]};
  // Alternate order to limit warm-cache/order bias; first pair warms both.
  for(let i=0;i<9;i++)for(const name of i%2?['candidate','baseline']:['baseline','candidate']){
   const start=performance.now();const r=await db.query((name==='baseline'?baseline:candidate)(Boolean(store)),args);
   assert.equal(r.rowCount,fixture.n);if(i)row[name].push(performance.now()-start);
  }
  row.baseline=stats(row.baseline);row.candidate=stats(row.candidate);
  for(const [name,sql]of [['baseline',baseline],['candidate',candidate]])row[name].explain=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql(Boolean(store)),args)).rows[0]['QUERY PLAN'][0];
  const engine={baseline:[],candidate:[]};
  for(let i=0;i<8;i++)for(const name of i%2?['candidate','baseline']:['baseline','candidate']){
   const plan=(await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+(name==='baseline'?baseline:candidate)(Boolean(store)),args)).rows[0]['QUERY PLAN'][0];
   engine[name].push(plan['Execution Time']);
  }
  row.baseline.engine=stats(engine.baseline);row.candidate.engine=stats(engine.candidate);
  report.cases.push(row);
 }
 await db.query('BEGIN');
 const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,plan_code) VALUES('Bootstrap SQL edge fixture','ACTIVE','2099-01-01','PREMIUM') RETURNING id")).rows[0].id;
 const edgeStores=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'A'),($1,'B') RETURNING id",[org])).rows.map(r=>r.id);
 const products=(await db.query("INSERT INTO products(organization_id,name,metadata) VALUES($1,'No balance','{\"stockByStore\":{\"stale\":999}}'),($1,'Decimal balance','{\"nullable\":null}'),($1,'Zero balance','{}') RETURNING id",[org])).rows.map(r=>r.id);
 await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$4,1.250),($1,$3,$4,-2.125),($1,$2,$5,0)',[org,...edgeStores,products[1],products[2]]);
 for(const [i,store]of [edgeStores[0],edgeStores[0],edgeStores[1]].entries()){
  const sale=(await db.query("INSERT INTO sales(organization_id,store_id,sale_number,created_at) VALUES($1,$2,$3,$4) RETURNING id",[org,store,'EDGE-'+i,`2026-01-0${i+1}T12:00:00Z`])).rows[0].id;
  await db.query("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total) VALUES($1,$2,'Edge',1,0,0)",[sale,products[1]]);
 }
 await assertEquivalent(org,edgeStores);
 const owner=(await db.query(candidate(false),[org])).rows;
 assert.deepEqual(owner.find(p=>p.id===products[0]).stock_by_store,{});
 assert.equal(owner.find(p=>p.id===products[0]).last_sale_at,null);
 assert.equal(owner.find(p=>p.id===products[1]).last_sale_at.toISOString(),'2026-01-03T12:00:00.000Z');
 const branch=(await db.query(candidate(true),[org,edgeStores[0]])).rows.find(p=>p.id===products[1]);
 assert.deepEqual(branch.stock_by_store,{[edgeStores[0]]:1.25});
 assert.equal(branch.last_sale_at.toISOString(),'2026-01-02T12:00:00.000Z');
 await db.query('ROLLBACK');report.edgeEquivalence='passed: missing/zero/negative/decimal balances, metadata, multiple and branch-specific sale timestamps, tenant exclusion';
 console.log(JSON.stringify(report,null,2));
}finally{await db.query('ROLLBACK');db.release();await pool.end()}
