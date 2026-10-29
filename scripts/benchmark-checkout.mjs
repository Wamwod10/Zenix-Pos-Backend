import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {availableParallelism} from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';

const url=process.env.TEST_DATABASE_URL;
assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.DATABASE_URL,url);
const target=assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
assert.equal(target.hostname,'127.0.0.1');
assert.ok(['5432','55436'].includes(target.port),'only isolated local/CI PostgreSQL ports');
const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`,suffix=randomUUID();
const samples={},sales=[],returns=[];
let maxWaiting=0,maxConnections=0;
const monitor=setInterval(()=>{maxWaiting=Math.max(maxWaiting,pool.waitingCount);maxConnections=Math.max(maxConnections,pool.totalCount)},5);
const started=performance.now(),cpuStart=process.cpuUsage();
const request=async(path,token,body,expected=201)=>{
 const start=performance.now();
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:`zenix_session=${token}`},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const result=await response.json(),ms=performance.now()-start;
 assert.equal(response.status,expected,JSON.stringify(result));
 return {data:result.data,ms};
};
try{
 const fixture=async(label)=>{
  const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES($1,'ACTIVE',CURRENT_DATE+30) RETURNING id",[`Checkout perf ${label} ${suffix}`])).rows[0].id;
  const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Synthetic') RETURNING id",[org])).rows[0].id;
  const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Synthetic',$3,'not-a-password','CASHIER') RETURNING id",[org,store,label+suffix])).rows[0].id;
  const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);
  const product=(await pool.query("INSERT INTO products(organization_id,name,sell_price,cost_price) VALUES($1,'Synthetic',100,25) RETURNING id",[org])).rows[0].id;
  await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,10000,25)',[org,store,product]);
  const shift=(await pool.query("INSERT INTO shifts(organization_id,store_id,cashier_id,opening_cash,status,register_key) VALUES($1,$2,$3,100000,'open',$4) RETURNING id",[org,store,user,`store:${store}`])).rows[0].id;
  return {org,store,user,token,product,shift};
 };
 const f=await fixture('main'),other=await fixture('other');
 const payments={cash:[{method:'cash',amount:100}],card:[{method:'card',amount:100}],transfer:[{method:'transfer',amount:100}],mixed:[{method:'cash',amount:40},{method:'card',amount:60}]};
 const body=(mode,ref=randomUUID())=>({storeId:f.store,shiftId:f.shift,clientReference:ref,items:[{productId:f.product,quantity:1,unitPrice:100}],payments:payments[mode]});
 const checkout=async(mode,label,record=true)=>{
  const result=await request('/api/sales',f.token,body(mode));
  sales.push({id:result.data.sale.id,mode});if(record)(samples[label]??=[]).push(result.ms);
  return result.data.sale;
 };
 // Warm all payment paths before the recorded sequential series.
 for(const mode of Object.keys(payments))await checkout(mode,'warmup',false);
 for(const mode of Object.keys(payments))for(let i=0;i<30;i++){
  const sale=await checkout(mode,`checkout_${mode}`);
  const result=await request(`/api/sales/${sale.id}/returns`,f.token,{productId:f.product,quantity:1,reason:'Synthetic benchmark',refundMethod:'original',refundShiftId:f.shift,clientReference:randomUUID()});
  assert.equal(Number(result.data.return.amount),100);
  assert.equal(Number(result.data.return.refundBreakdown.cash),mode==='cash'?100:mode==='mixed'?40:0);
  assert.equal(Number(result.data.return.refundBreakdown.card),mode==='card'?100:mode==='mixed'?60:0);
  assert.equal(Number(result.data.return.refundBreakdown.transfer||0),mode==='transfer'?100:0);
  returns.push(result.data.return.id);(samples[`refund_${mode}`]??=[]).push(result.ms);
 }
 for(const concurrency of [10,50]){
  // Three bounded bursts give at least 30 latency observations at each load.
  for(let round=0;round<3;round++)await Promise.all(Array.from({length:concurrency},(_,i)=>checkout(['cash','card','mixed'][i%3],`concurrent_${concurrency}`)));
 }
 const replayBody=body('mixed'),replies=await Promise.all(Array.from({length:10},()=>request('/api/sales',f.token,replayBody)));
 assert.equal(new Set(replies.map(r=>r.data.sale.id)).size,1);
 // A later retry after a lost HTTP acknowledgement must still resolve to that sale.
 const lateReplay=await request('/api/sales',f.token,replayBody);
 assert.equal(lateReplay.data.sale.id,replies[0].data.sale.id);
 sales.push({id:replies[0].data.sale.id,mode:'mixed'});
 samples.duplicate_replay=replies.map(r=>r.ms);
 await request('/api/sales',f.token,{...replayBody,payments:payments.cash},409);
 await request(`/api/sales/page?storeId=${f.store}`,other.token,undefined,403);
 await request(`/api/sales/${sales[0].id}/returns`,other.token,{productId:f.product,quantity:1,reason:'Isolation probe',refundMethod:'original',clientReference:randomUUID()},404);
 const stock=(await pool.query('SELECT quantity FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3',[f.org,f.store,f.product])).rows[0];
 assert.equal(Number(stock.quantity),10000-sales.length+returns.length);
 const totals=(await pool.query('SELECT count(*)::int count,sum(total) total,sum(returned_amount) returned FROM sales WHERE organization_id=$1',[f.org])).rows[0];
 assert.equal(totals.count,sales.length);assert.equal(Number(totals.total),sales.length*100);assert.equal(Number(totals.returned),returns.length*100);
 const savedPayments=(await pool.query('SELECT p.method,sum(p.amount) amount FROM sale_payments p JOIN sales s ON s.id=p.sale_id WHERE s.organization_id=$1 GROUP BY p.method',[f.org])).rows;
 for(const method of ['cash','card','transfer'])assert.equal(Number(savedPayments.find(p=>p.method===method)?.amount??0),sales.reduce((n,s)=>n+(payments[s.mode].find(p=>p.method===method)?.amount??0),0));
 assert.equal(Number((await pool.query('SELECT count(*) count FROM sale_returns WHERE organization_id=$1',[f.org])).rows[0].count),returns.length);
 assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE organization_id=$1',[other.org])).rows[0].quantity),10000);
 assert.equal(Number((await pool.query('SELECT count(*) count FROM sales WHERE organization_id=$1',[other.org])).rows[0].count),0);
 const stats=Object.fromEntries(Object.entries(samples).map(([key,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [key,{n:values.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],p99:sorted[Math.ceil(sorted.length*.99)-1]}]}));
 if(process.env.CHECKOUT_P95_BUDGET_MS){
  const budget=Number(process.env.CHECKOUT_P95_BUDGET_MS);assert.ok(Number.isFinite(budget)&&budget>0);
  for(const mode of ['cash','card','transfer','mixed'])assert.ok(stats[`checkout_${mode}`].p95<budget,`${mode} checkout P95 exceeds ${budget}ms`);
 }
 const {performanceMetrics}=await import('../src/lib/performanceMetrics.js');
 const result={timestamp:new Date().toISOString(),fixtureOrganization:f.org,stats,checks:{sales:sales.length,refunds:returns.length,stock:Number(stock.quantity),paymentTotals:savedPayments,duplicateReplay:true,tenantIsolation:true},environment:{node:process.version,availableParallelism:availableParallelism(),poolMax:pool.options.max,maxConnections,maxWaiting,elapsedMs:performance.now()-started,nodeCpuMicros:process.cpuUsage(cpuStart),note:'Local HTTP and disposable loopback PostgreSQL; one hot product/shift; CPU includes fixture setup; three bursts per concurrency; no production extrapolation'},diagnostics:performanceMetrics.snapshot(),samples};
 const output=new URL('../../artifacts/performance-continuation-20261016/',import.meta.url);await mkdir(output,{recursive:true});
 await writeFile(new URL('checkout-results.json',output),JSON.stringify(result,null,2));
 await writeFile(new URL('checkout-results.md',output),`# Checkout benchmark\n\nAuthenticated local HTTP, synthetic fixtures; milliseconds, nearest-rank percentiles.\n\n| Path | N | P50 | P95 | P99 |\n|---|---:|---:|---:|---:|\n${Object.entries(stats).map(([k,v])=>`| ${k} | ${v.n} | ${v.p50.toFixed(2)} | ${v.p95.toFixed(2)} | ${v.p99.toFixed(2)} |`).join('\n')}\n\nExact stock, sales, returned amounts, cash/card totals, concurrent duplicate replay and tenant isolation assertions passed. ${sales.length} unique sales, ${returns.length} refunds. Pool max ${pool.options.max}; observed connections ${maxConnections}, waiting ${maxWaiting}. Host available parallelism ${availableParallelism()}. ${result.environment.note}.\n`);
 console.log(JSON.stringify({...result,samples:undefined},null,2));
}finally{clearInterval(monitor);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()}
