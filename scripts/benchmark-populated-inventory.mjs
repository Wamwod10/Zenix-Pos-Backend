import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
const target=assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55436');assert.equal(target.pathname,'/zenix_perf_test');
process.env.DATABASE_MIGRATION_URL=url;process.env.ZENIX_PERFORMANCE_METRICS='true';
const [{app},{pool},{sha256},{performanceMetrics}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js'),import('../src/lib/performanceMetrics.js')]);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`,results=[],plans=[];
const reuse=process.argv.includes('--reuse-fixture');
const originalQuery=pool.query.bind(pool);let catalogQuery;
pool.query=(sql,values,...args)=>{if(typeof sql==='string'&&sql.includes('FROM products p WHERE'))catalogQuery={sql,values};return originalQuery(sql,values,...args)};
const percentile=values=>{const s=[...values].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],p99:s[Math.ceil(s.length*.99)-1]}};
let maxWaiting=0,maxRss=0;
const monitor=setInterval(()=>{maxWaiting=Math.max(maxWaiting,pool.waitingCount);maxRss=Math.max(maxRss,process.memoryUsage().rss)},10);
try{
 const org=reuse?(await pool.query("SELECT id FROM organizations WHERE name='Populated inventory synthetic benchmark' ORDER BY created_at DESC LIMIT 1")).rows[0]?.id:(await pool.query("INSERT INTO organizations(name,license_status,expiry_date,plan_code) VALUES('Populated inventory synthetic benchmark','ACTIVE','2099-01-01','PREMIUM') RETURNING id")).rows[0].id;
 assert.ok(org,'No existing populated fixture');
 const stores=(await pool.query(reuse?'SELECT id FROM stores WHERE organization_id=$1 ORDER BY name':"INSERT INTO stores(organization_id,name) VALUES($1,'Synthetic A'),($1,'Synthetic B') RETURNING id",[org])).rows.map(r=>r.id);
 const user=(await pool.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Synthetic',$2,'not-a-password','OWNER') RETURNING id",[org,randomUUID()])).rows[0].id;
 const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);
 const request=async(path,validate)=>{
  const start=performance.now(),response=await fetch(base+path,{headers:{cookie:`zenix_session=${token}`,'x-zenix-client':'web',origin:'http://localhost:5173'},signal:AbortSignal.timeout(30000)});
  const bytes=await response.arrayBuffer();assert.equal(response.status,200,Buffer.from(bytes).toString().slice(0,300));
  if(validate)validate(JSON.parse(Buffer.from(bytes).toString()).data);
  return {ms:performance.now()-start,bytes:bytes.byteLength};
 };
 const measure=async(label,path,validate,n=30)=>{
  await request(path,validate);const samples=[],bytes=[];
  for(let i=0;i<n;i++){const r=await request(path,validate);samples.push(r.ms);bytes.push(r.bytes)}
  results.push({label,...percentile(samples),responseBytes:{min:Math.min(...bytes),max:Math.max(...bytes)},samples});console.log(label,JSON.stringify(results.at(-1),(_k,v)=>_k==='samples'?undefined:v));
 };
 let previous=0;
 for(const size of reuse?[50000]:[1000,10000,50000]){
  for(let start=reuse?size+1:previous+1;start<=size;start+=1000){
   const end=Math.min(start+999,size);
   await pool.query("INSERT INTO products(organization_id,name,sku,barcode,sell_price,cost_price) SELECT $1,'Synthetic product '||n,'POP-'||lpad(n::text,5,'0'),'998'||lpad(n::text,10,'0'),100,25 FROM generate_series($2::int,$3::int)n",[org,start,end]);
   await pool.query("INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) SELECT $1,s.id,p.id,100,25 FROM products p CROSS JOIN stores s WHERE p.organization_id=$1 AND s.organization_id=$1 AND p.sku BETWEEN $2 AND $3",[org,'POP-'+String(start).padStart(5,'0'),'POP-'+String(end).padStart(5,'0')]);
   await pool.query("INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,unit_cost,reference_type,reason,created_by) SELECT b.organization_id,b.store_id,b.product_id,'IN',100,0,100,25,'benchmark','Synthetic initial receipt',$4 FROM inventory_balances b JOIN products p ON p.id=b.product_id WHERE b.organization_id=$1 AND p.sku BETWEEN $2 AND $3",[org,'POP-'+String(start).padStart(5,'0'),'POP-'+String(end).padStart(5,'0'),user]);
  }
  previous=size;await pool.query('ANALYZE products');await pool.query('ANALYZE inventory_balances');
  console.log('Populated fixture ready',size);
  const validate=data=>{assert.equal(data.products.length,50);assert.ok(data.products.every(p=>p.organization_id===org&&Object.values(p.stock_by_store).length===2&&Object.values(p.stock_by_store).every(q=>Number(q)===100)))};
  await measure(`page_${size}`,'/api/products/page?limit=50',validate);
  const q=catalogQuery;plans.push({label:`page_${size}`,sql:q.sql,values:q.values,explain:(await originalQuery(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${q.sql}`,q.values)).rows[0]['QUERY PLAN']});
 }
 for(const [label,search,count]of [['rare','POP-49999',1],['no_match','absent-populated-fixture',0],['barcode','9980000049999',1]]){
  await measure(label,'/api/products/page?limit=50&search='+encodeURIComponent(search),data=>assert.equal(data.products.length,count));
  const q=catalogQuery;plans.push({label,sql:q.sql,values:q.values,explain:(await originalQuery(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${q.sql}`,q.values)).rows[0]['QUERY PLAN']});
 }
 // Stock receipt history is financially neutral; sales history uses zero totals
 // and no lines, avoiding fabricated stock reductions or inconsistent payments.
 if(!reuse)await pool.query("INSERT INTO sales(organization_id,store_id,seller_id,sale_number,subtotal,total,business_date) SELECT $1,$2,$3,'POP-HISTORY-'||n,0,0,CURRENT_DATE FROM generate_series(1,1000)n",[org,stores[0],user]);
 await measure('bootstrap_50000','/api/bootstrap',data=>assert.ok(data));
 for(const concurrency of [1,10,50,100]){
  maxWaiting=0;maxRss=process.memoryUsage().rss;performanceMetrics.reset();const samples=[],sizes=[],errors=[];
  const started=performance.now(),cpu=process.cpuUsage(),until=started+10000;
  await Promise.all(Array.from({length:concurrency},async()=>{while(performance.now()<until){try{const r=await request('/api/products/page?limit=50');samples.push(r.ms);sizes.push(r.bytes)}catch(e){errors.push(e.message);break}if(process.memoryUsage().rss>1.5*1024**3){errors.push('Stopped at 1.5GiB RSS bound');break}}}));
  const row={label:'bounded_read_users',concurrency,...percentile(samples),elapsedMs:performance.now()-started,cpuMicros:process.cpuUsage(cpu),maxWaiting,maxRss,errors,responseBytes:{min:Math.min(...sizes),max:Math.max(...sizes)},metrics:performanceMetrics.snapshot()};results.push(row);console.log(JSON.stringify(row));if(errors.length)break;
 }
 const counts=(await pool.query("SELECT (SELECT count(*) FROM products WHERE organization_id=$1)::int products,(SELECT count(*) FROM inventory_balances WHERE organization_id=$1)::int inventory,(SELECT count(*) FROM warehouse_balances WHERE organization_id=$1)::int warehouse,(SELECT count(*) FROM stock_movements WHERE organization_id=$1)::int movements,(SELECT count(*) FROM sales WHERE organization_id=$1)::int history",[org])).rows[0];
 assert.deepEqual(counts,{products:50000,inventory:100000,warehouse:100000,movements:100000,history:1000});
 const invalid=(await pool.query('SELECT count(*)::int count FROM inventory_balances b LEFT JOIN warehouse_balances w USING(organization_id,store_id,product_id) WHERE b.organization_id=$1 AND (b.quantity<>100 OR w.quantity IS DISTINCT FROM b.quantity)',[org])).rows[0].count;assert.equal(invalid,0);
 const report={timestamp:new Date().toISOString(),environment:{node:process.version,poolMax:pool.options.max,target:'Disposable local PostgreSQL / local authenticated HTTP',notes:'All security and consistency triggers active. Two stores/default warehouses, initial stock 100 per product per store. 1000 zero-value synthetic sales for history; 100k receipt movements. Load stages target 10 seconds plus draining in-flight requests. CPU is Node process only; RSS includes HTTP client. No runtime optimization inferred.'},fixtureOrganization:org,counts,results,plans};
 const output=new URL('../../artifacts/performance-continuation-20261016/',import.meta.url);await mkdir(output,{recursive:true});await writeFile(new URL(reuse?'populated-inventory-results-after.json':'populated-inventory-results.json',output),JSON.stringify(report,null,2));
 await writeFile(new URL(reuse?'populated-inventory-results-after.md':'populated-inventory-results.md',output),`# Populated inventory benchmark\n\n${report.environment.notes}\n\n| Operation | Users | N | P50 ms | P95 ms | P99 ms | Max bytes | Errors |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${results.map(r=>`| ${r.label} | ${r.concurrency??1} | ${r.n} | ${r.p50?.toFixed(2)} | ${r.p95?.toFixed(2)} | ${r.p99?.toFixed(2)} | ${r.responseBytes.max} | ${r.errors?.length??0} |`).join('\n')}\n\nFixture counts and warehouse/branch quantities verified. Pool maximum ${pool.options.max}. SQL EXPLAIN ANALYZE BUFFERS and per-stage CPU/RSS/pool metrics are in JSON.\n`);
 console.log('Populated inventory benchmark complete',JSON.stringify(counts));
}finally{clearInterval(monitor);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()}
