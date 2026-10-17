// Disposable PostgreSQL only. Creates synthetic fixtures, never accepts a remote URL.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.DATABASE_URL,url);
// Prevent dotenv or pre-existing migration settings from selecting another DB.
process.env.DATABASE_MIGRATION_URL=url;
const baseline=process.argv.includes('--baseline');
if(baseline)registerHooks({load(url,context,next){
 if(url.endsWith('/src/lib/bootstrapDates.js'))return {format:'module',shortCircuit:true,source:`export const createBootstrapDateParts=(timeZone='Asia/Tashkent')=>value=>{const date=value?new Date(value):new Date();return {dateISO:new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date),date:new Intl.DateTimeFormat('uz-UZ',{timeZone,day:'2-digit',month:'2-digit',year:'numeric'}).format(date),time:new Intl.DateTimeFormat('uz-UZ',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date)}};`};
 return next(url,context);
}});
const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const results=[];
let catalogQuery;
const query=pool.query.bind(pool);
pool.query=(text,values,...rest)=>{
 if(typeof text==='string'&&text.includes('FROM products p WHERE'))catalogQuery={text,values};
 return query(text,values,...rest);
};
let org;
const summarize=samples=>{samples.sort((a,b)=>a-b);return {samples:samples.length,p50:samples[Math.ceil(samples.length*.5)-1],p95:samples[Math.ceil(samples.length*.95)-1],p99:samples[Math.ceil(samples.length*.99)-1]}};
try{
 org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date,plan_code) VALUES('Synthetic performance fixture','ACTIVE','2099-01-01','PREMIUM') RETURNING id")).rows[0].id;
 const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Benchmark') RETURNING id",[org])).rows[0].id;
 const user=(await pool.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Benchmark',$2,'not-a-password','OWNER') RETURNING id",[org,randomUUID()])).rows[0].id;
 const token=randomUUID();
 await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);
 const request=async path=>{
  const started=performance.now();
  const response=await fetch(base+path,{headers:{cookie:`zenix_session=${token}`,'x-zenix-client':'web',origin:'http://localhost:5173'},signal:AbortSignal.timeout(30000)});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  return {ms:performance.now()-started,data:body.data};
 };
 let previous=0;
 for(const size of process.argv.includes('--bootstrap-only')?[1000]:[100,1000,10000,50000]){
  for(let start=previous+1;start<=size;start+=1000){
   await pool.query("INSERT INTO products(organization_id,name,sku,barcode,unit,sell_price,cost_price) SELECT $1,'Guruch '||n,'SKU-'||n,'998'||lpad(n::text,10,'0'),'dona',12500,10000 FROM generate_series($2::int,$3::int) n",[org,start,Math.min(size,start+999)]);
  }
  console.log(`Fixture ready: ${size} products`);
  previous=size;
  await pool.query('ANALYZE products');
  const path='/api/products/page?limit=50&search=Guruch';
  for(let i=0;i<3;i++)await request(path);
  const samples=[];
  for(let i=0;i<30;i++){const result=await request(path);assert.equal(result.data.products.length,50);assert.ok(result.data.products.every(p=>p.organization_id===org));samples.push(result.ms)}
  results.push({operation:'catalog-page-http',products:size,...summarize(samples)});
  const plan=(await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${catalogQuery.text}`,catalogQuery.values)).rows[0]['QUERY PLAN'][0];
  results.push({operation:'catalog-page-plan',products:size,planningMs:plan['Planning Time'],executionMs:plan['Execution Time'],plan:plan.Plan});
 }
 // Bootstrap includes up to 3,000 latest sales. Supply 1,000 synthetic rows.
 await pool.query("INSERT INTO sales(organization_id,store_id,seller_id,sale_number,subtotal,total,business_date) SELECT $1,$2,$3,'BENCH-'||n,12500,12500,CURRENT_DATE FROM generate_series(1,1000) n",[org,store,user]);
 // Keep the bootstrap fixture bounded at 1,000 products; large catalog HTTP was measured above.
 await pool.query('DELETE FROM products WHERE organization_id=$1 AND id NOT IN (SELECT id FROM products WHERE organization_id=$1 ORDER BY id LIMIT 1000)',[org]);
 for(let i=0;i<3;i++)await request('/api/bootstrap');
 const bootstrapSamples=[];
 for(let i=0;i<30;i++)bootstrapSamples.push((await request('/api/bootstrap')).ms);
 results.push({operation:'bootstrap-http',products:1000,sales:1000,...summarize(bootstrapSamples)});
 const delay=monitorEventLoopDelay({resolution:10});delay.enable();
 for(const concurrency of [1,10,50,100]){
  const samples=[];let errors=0,nextRequest=0;
  const started=performance.now(),memoryBefore=process.memoryUsage().rss,cpu=process.cpuUsage();
  await Promise.all(Array.from({length:concurrency},async()=>{
   while(nextRequest++<200){try{samples.push((await request('/api/products/page?limit=50')).ms)}catch{errors++}}
  }));
  results.push({operation:'concurrent-catalog-http',products:1000,concurrency,requests:200,errors,elapsedMs:performance.now()-started,rssDeltaBytes:process.memoryUsage().rss-memoryBefore,cpuMicros:process.cpuUsage(cpu),...summarize(samples)});
  assert.equal(errors,0);
 }
 delay.disable();
 const report={mode:baseline?'baseline':'optimized',environment:'local Node, Docker PostgreSQL 16, loopback HTTP, synthetic fixtures',results,eventLoopDelayP95Ms:delay.percentile(95)/1e6};
 await writeFile(`performance-api-${baseline?'before':'after'}.json`,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{
 await new Promise(resolve=>server.close(resolve));
 // Fixtures remain in this disposable container until it is removed; cascading
 // organization deletion conflicts with the database's write authorization guard.
 await pool.end();
}
