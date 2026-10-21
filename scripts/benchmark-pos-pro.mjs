import {performance} from 'node:perf_hooks';
import {writeFile,mkdir} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
import {readPosCatalog} from '../src/services/posCatalog.js';
assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
if(process.env.NODE_ENV!=='test'||process.env.DATABASE_URL!==process.env.TEST_DATABASE_URL)throw Error('Isolated test database required');
const {pool}=await import('../src/db/pool.js');const db=await pool.connect(),results=[];
const summarize=values=>{const a=values.toSorted((a,b)=>a-b);return {samples:a.length,minMs:a[0],p50Ms:a[Math.floor(a.length*.5)],p95Ms:a[Math.ceil(a.length*.95)-1],maxMs:a.at(-1)}};
try{
 await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='120s'");
 const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('POS Pro benchmark','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
 const storeId=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Benchmark branch') RETURNING id",[org])).rows[0].id,user={organizationId:org,appRole:'OWNER'};
 for(const size of [10000,50000]){
  await db.query("INSERT INTO products(organization_id,name,barcode,sku,category,unit,sell_price) SELECT $1,'Bench '||lpad(i::text,6,'0'),'BENCH'||i,'SKU'||i,'Food','kg',12000 FROM generate_series($2::int,$3::int) i",[org,size===10000?1:10001,size]);
  await db.query('ANALYZE products');
  for(const [kind,query] of [['page',{limit:40}],['tail-search',{search:'Bench '+String(size).padStart(6,'0'),limit:40}],['barcode',{barcode:'BENCH'+size}]]){
   const durations=[];for(let i=0;i<12;i++){const start=performance.now();const result=await readPosCatalog(db,user,{storeId,...query});durations.push(performance.now()-start);if(!result.products.length)throw Error('Benchmark lookup returned no products');if(result.products.length>40)throw Error('Unbounded page')}
   results.push({catalogSize:size,kind,...summarize(durations)});
  }
 }
 console.log(JSON.stringify({database:'disposable PostgreSQL loopback',scope:'Actual SQL/service timings, not internet or browser latency',results},null,2));
 await mkdir('../artifacts/phase2',{recursive:true});await writeFile('../artifacts/phase2/postgres-benchmark.json',JSON.stringify({results},null,2));
}finally{await db.query('ROLLBACK');db.release();await pool.end()}
