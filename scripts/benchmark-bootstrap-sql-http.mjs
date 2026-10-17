// Authenticated loopback HTTP; switches only products SQL between matched requests.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {get} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {mkdir,writeFile} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL,target=assertSafeTestDatabaseUrl(url);
assert.equal(process.env.NODE_ENV,'test');assert.equal(url,process.env.DATABASE_URL);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55436');assert.equal(target.pathname,'/zenix_perf_test');
process.env.ZENIX_PERFORMANCE_METRICS='true';
const [{app},{pool},{sha256},{performanceMetrics}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js'),import('../src/lib/performanceMetrics.js')]);
const baseline=branch=>`SELECT p.*,
 COALESCE(jsonb_object_agg(ib.store_id,ib.quantity) FILTER (WHERE ib.store_id IS NOT NULL),'{}'::jsonb) AS stock_by_store,max(ls.last_sale_at) AS last_sale_at
 FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id AND ib.organization_id=p.organization_id ${branch?'AND ib.store_id=$2':''}
 LEFT JOIN (SELECT si.product_id,max(s.created_at) AS last_sale_at FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.organization_id=$1 ${branch?'AND s.store_id=$2':''} GROUP BY si.product_id) ls ON ls.product_id=p.id
 WHERE p.organization_id=$1 GROUP BY p.id ORDER BY p.created_at`;
let before=false;const query=pool.query.bind(pool);
pool.query=(sql,values,...rest)=>query(before&&typeof sql==='string'&&sql.includes("SELECT p.*,COALESCE(ib.stock_by_store")?baseline(values.length>1):sql,values,...rest);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const output=new URL('../../artifacts/performance-final-20261016/',import.meta.url);await mkdir(output,{recursive:true});
const samples=[];let monitor,maxRss=0;
try{
 const user=(await pool.query("SELECT u.id FROM users u JOIN organizations o ON o.id=u.organization_id WHERE o.name='Populated inventory synthetic benchmark' AND u.app_role='OWNER' ORDER BY u.created_at LIMIT 1")).rows[0];assert.ok(user);
 const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user.id,sha256(token)]);
 let first;
 for(let i=0;i<66;i++){
  before=i%2===0;performanceMetrics.reset();maxRss=process.memoryUsage().rss;monitor=setInterval(()=>maxRss=Math.max(maxRss,process.memoryUsage().rss),10);
  const start=performance.now(),cpu=process.cpuUsage();
  const raw=await new Promise((resolve,reject)=>{const req=get(`http://127.0.0.1:${server.address().port}/api/bootstrap`,{headers:{cookie:`zenix_session=${token}`,'x-zenix-client':'web',origin:'http://localhost:5173','accept-encoding':'gzip'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,encoding:res.headers['content-encoding'],body:Buffer.concat(chunks)}))});req.setTimeout(30000,()=>req.destroy(new Error('Local benchmark timeout')));req.on('error',reject)});
  assert.equal(raw.status,200);const decodeStart=performance.now(),decoded=raw.encoding==='gzip'?gunzipSync(raw.body):raw.body,parseStart=performance.now(),body=JSON.parse(decoded),parsed=performance.now();
  assert.equal(body.data.inventory.length,50000);assert.ok(body.data.inventory.every(p=>Object.values(p.stockByStore).length===2&&Object.values(p.stockByStore).every(q=>Number(q)===100)));
  clearInterval(monitor);
  const row={before,totalMs:performance.now()-start,decodeMs:parseStart-decodeStart,parseMs:parsed-parseStart,wireBytes:raw.body.length,jsonBytes:decoded.length,maxRss:Math.max(maxRss,process.memoryUsage().rss),cpuMicros:process.cpuUsage(cpu),metrics:performanceMetrics.snapshot()};
  if(i===0){first=body.data.inventory;await writeFile(new URL('bootstrap-fixture-legacy.json',output),decoded);}
  if(i===1){const sorted=items=>items.toSorted((a,b)=>a.id.localeCompare(b.id));assert.deepEqual(sorted(first),sorted(body.data.inventory));first=null;}
  if(i>=6)samples.push(row);console.log(i,before?'before':'after',row.totalMs.toFixed(1));
 }
 const stats=values=>{const s=[...values].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],p99:s.at(-1)}};
 const groups=Object.fromEntries([true,false].map(before=>{const rows=samples.filter(s=>s.before===before);return [before?'before':'after',{...Object.fromEntries(['totalMs','decodeMs','parseMs','wireBytes','jsonBytes','maxRss'].map(key=>[key,stats(rows.map(r=>r[key]))])),phases:Object.fromEntries(['bootstrap.serialize','bootstrap.compress'].map(key=>[key,stats(rows.map(r=>r.metrics[key]?.p50).filter(Number.isFinite))]))}]}));
 const result={environment:'Full synthetic50k/100kbalances;30 alternating local HTTP observations per SQL; gzip level1 unchanged; total includes client decode/parse/stock validation; RSS and CPU include local load client, not Render capacity',inventoryParity:'all50000 products deeply equal after sorting byid; timestamp ties have no guaranteed order',groups,samples};
 await writeFile(new URL('bootstrap-sql-http.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,samples:undefined},null,2));
}finally{clearInterval(monitor);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end();}
