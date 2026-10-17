// Disposable local benchmark only. Never accepts a remote or production database.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {get} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;assertSafeTestDatabaseUrl(url);assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DATABASE_URL,url);
const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55436');assert.equal(parsed.pathname,'/zenix_perf_test');assert.equal(parsed.searchParams.get('sslmode'),'disable');
const output=fileURLToPath(new URL('../../artifacts/performance-progressive-20261017/',import.meta.url));
await mkdir(output,{recursive:true});
for(const name of ['http-results.json','fixtures.json','runtime.json']){let exists=false;try{await access(`${output}/${name}`);exists=true}catch{}assert.equal(exists,false,`Refusing to overwrite ${name}`)}
const [{app},{pool},{sha256},{default:bcrypt}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js'),import('bcryptjs')]);
const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
const baseURL=`http://127.0.0.1:${server.address().port}`,fixtures=[],results=[],sessions=[];
const save=(name,value)=>writeFile(`${output}/${name}`,JSON.stringify(value,null,2),{flag:'wx'});
const request=(path,token,core=false)=>new Promise((resolve,reject)=>{
 const start=performance.now(),req=get(baseURL+path,{headers:{cookie:`zenix_session=${token}`,'x-zenix-client':'web',origin:'http://localhost:5173','accept-encoding':'gzip',...(core?{'x-zenix-bootstrap':'core'}:{})}},res=>{
  const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{
   try{const wire=Buffer.concat(chunks),decodeStart=performance.now(),decoded=res.headers['content-encoding']==='gzip'?gunzipSync(wire):wire,parseStart=performance.now(),body=JSON.parse(decoded),done=performance.now();assert.equal(res.statusCode,200,JSON.stringify(body));resolve({body,sample:{ms:done-start,parseMs:done-parseStart,decodeMs:parseStart-decodeStart,wireBytes:wire.length,jsonBytes:decoded.length,rss:process.memoryUsage().rss,encoding:res.headers['content-encoding']||'identity'}})}catch(error){reject(error)}
  });
 });req.setTimeout(60000,()=>req.destroy(Error('Benchmark timeout')));req.on('error',reject);
});
const percentile=(values,p)=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const stats=samples=>Object.fromEntries(['ms','parseMs','decodeMs','wireBytes','jsonBytes','rss'].map(key=>[key,{p50:percentile(samples.map(s=>s[key]),.5),p95:percentile(samples.map(s=>s[key]),.95),p99:percentile(samples.map(s=>s[key]),.99)}]));
let closing=false;async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
try{
 for(const size of [1000,10000,50000]){
  const existing=(await pool.query("SELECT o.id organization_id,u.id user_id,u.username FROM organizations o JOIN users u ON u.organization_id=o.id WHERE o.name LIKE $1 AND u.username LIKE $2 ORDER BY o.created_at DESC LIMIT 1",[`Progressive bootstrap synthetic ${size} %`,`progressive_${size}_%`])).rows[0];
  let org,stores,user,username,password;
  if(existing){org=existing.organization_id;user=existing.user_id;username=existing.username;password=`Synthetic-${username.split('_').at(-1)}-only!`;stores=(await pool.query('SELECT id FROM stores WHERE organization_id=$1 ORDER BY name',[org])).rows.map(row=>row.id)}else{
  const suffix=randomUUID().slice(0,8),newPassword=`Synthetic-${suffix}-only!`,newUsername=`progressive_${size}_${suffix}`;
  org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date,store_limit) VALUES($1,'PREMIUM','ACTIVE','2099-01-01',4) RETURNING id",[`Progressive bootstrap synthetic ${size} ${suffix}`])).rows[0].id;
  stores=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Benchmark A'),($1,'Benchmark B') RETURNING id",[org])).rows.map(row=>row.id);
  user=(await pool.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Synthetic benchmark owner',$2,$3,'OWNER') RETURNING id",[org,newUsername,await bcrypt.hash(newPassword,10)])).rows[0].id;
  await pool.query(`INSERT INTO products(organization_id,name,sku,barcode,category,brand,unit,cost_price,sell_price,wholesale_price,min_stock,metadata,created_at)
   SELECT $1,'Benchmark product '||lpad(i::text,6,'0'),'SKU-'||lpad(i::text,6,'0'),'BC-'||lpad(i::text,6,'0'),'Category '||(i%8),'Synthetic','dona',25,100,90,5,
   jsonb_build_object('description','Synthetic benchmark fixture','customField','retained','variants','[]'::jsonb,'packagingOptions','[]'::jsonb),
   '2026-10-17T00:00:00Z'::timestamptz+i*interval '1 microsecond' FROM generate_series(1,$2::integer) i`,[org,size]);
  username=newUsername;password=newPassword;
  }
  // Chunk fixture balances so per-row integrity triggers cannot exceed runtime statement timeout.
  for(let offset=0;offset<size;offset+=1000)await pool.query(`INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost)
   SELECT p.organization_id,s.id,p.id,CASE WHEN s.id=$2 THEN 100 ELSE 200 END,25 FROM
   (SELECT id,organization_id FROM products WHERE organization_id=$1 ORDER BY id LIMIT 1000 OFFSET $3) p JOIN stores s ON s.organization_id=p.organization_id
   WHERE NOT EXISTS(SELECT 1 FROM inventory_balances b WHERE b.organization_id=p.organization_id AND b.store_id=s.id AND b.product_id=p.id)`,[org,stores[0],offset]);
  const last=(await pool.query('SELECT id FROM products WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[org])).rows[0].id;
  const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);
  fixtures.push({size,organizationId:org,storeIds:stores,storeId:stores[0],userId:user,username,password,lastProductId:last,lastBarcode:`BC-${String(size).padStart(6,'0')}`,lastName:`Benchmark product ${String(size).padStart(6,'0')}`});
  sessions.push(token);console.log(`Seeded ${size}`);
 }
 await save('fixtures.json',fixtures);
 if(process.argv.includes('--serve'))await save('runtime.json',{baseURL,pid:process.pid,databaseHost:'127.0.0.1:55436',fixtureFile:`${output}/fixtures.json`});
 if(process.argv.includes('--wait-for-benchmark')){console.log(`SEEDED READY ${baseURL}; waiting for newline before latency measurement`);const {createInterface}=await import('node:readline/promises');const input=createInterface({input:process.stdin,output:process.stdout});await input.question('');input.close()}
 for(const [fixtureIndex,fixture] of fixtures.entries()){
  const {size,storeIds:stores,lastProductId:last}=fixture,token=sessions[fixtureIndex];
  const groups={legacy:[],core:[],catalogFirst:[],catalogSearchLast:[],catalogBarcodeLast:[]};let legacySnapshot,coreSnapshot;
  const paths={legacy:'/api/bootstrap',core:'/api/bootstrap',catalogFirst:`/api/bootstrap/catalog?storeId=${stores[0]}&limit=50`,catalogSearchLast:`/api/bootstrap/catalog?storeId=${stores[0]}&search=${encodeURIComponent(fixture.lastName)}&limit=50`,catalogBarcodeLast:`/api/bootstrap/catalog?storeId=${stores[0]}&barcode=${fixture.lastBarcode}`};
  for(let iteration=-3;iteration<30;iteration++){
   const order=iteration%2?['legacy','core']:['core','legacy'];order.push('catalogFirst','catalogSearchLast','catalogBarcodeLast');
   for(const mode of order){
    const {body,sample}=await request(paths[mode],token,mode==='core');
    if(mode==='legacy'){assert.equal(body.data.inventory.length,size);legacySnapshot=body}
    else if(mode==='core'){assert.deepEqual(body.data.inventory,[]);assert.deepEqual(body.data.catalog,{complete:false,mode:'remote-v1'});coreSnapshot=body}
    else{assert.ok(body.data.products.length<=50);for(const product of body.data.products){const reference=legacySnapshot?.data.inventory.find(item=>item.id===product.id);if(reference){assert.deepEqual(product,{...reference,stockByStore:{[stores[0]]:reference.stockByStore[stores[0]]??0}})}if(mode!=='catalogFirst')assert.equal(product.id,last)}assert.equal(body.data.products.length,mode==='catalogFirst'?50:1)}
    if(iteration>=0)groups[mode].push(sample);
   }
  }
  await save(`bootstrap-${size}-legacy.json`,legacySnapshot);await save(`bootstrap-${size}-core.json`,coreSnapshot);
  results.push({size,groups:Object.fromEntries(Object.entries(groups).map(([mode,samples])=>[mode,{samples:samples.length,...stats(samples),raw:samples}]))});
  console.log(`Measured ${size}: legacy ${stats(groups.legacy).ms.p95.toFixed(1)}ms/core ${stats(groups.core).ms.p95.toFixed(1)}ms p95`);
 }
 await save('http-results.json',{createdAt:new Date().toISOString(),note:'30 samples/group; 3 warmups; legacy/core order alternates; serial loopback requests; gzip; no throttling or concurrency stress. RSS is same-process server+client, not isolated browser memory.',results});
 if(process.argv.includes('--serve')){console.log(`READY ${baseURL}`)}else await close();
}catch(error){await close();throw error}
