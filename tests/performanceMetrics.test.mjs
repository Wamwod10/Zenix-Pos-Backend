import test from 'node:test';
import assert from 'node:assert/strict';
const {createPerformanceMetrics}=await import('../src/lib/performanceMetrics.js').catch(()=>({}));
const {instrumentPool}=await import('../src/db/performance.js').catch(()=>({}));
test('metrics use a bounded recent window with explicit lifetime counts and failures',()=>{
 assert.equal(typeof createPerformanceMetrics,'function');
 const metrics=createPerformanceMetrics({maxKeys:2,windowSize:4});
 for(let i=1;i<=6;i++)metrics.observe('query',i,{failed:i===6});
 metrics.observe('acquire',2);metrics.observe('excess',3);metrics.observe('query',NaN);
 const result=metrics.snapshot();
 assert.equal(Object.keys(result).length,2);
 assert.deepEqual(result.query,{count:6,failures:1,windowSamples:4,p50:4,p95:6,p99:6});
});
test('disabled metrics do not retain labels or samples',()=>{
 assert.equal(typeof createPerformanceMetrics,'function');
 const metrics=createPerformanceMetrics({enabled:false});metrics.observe('sensitive',3);
 assert.deepEqual(metrics.snapshot(),{});
});
test('pool instrumentation preserves promise/callback results, errors and release',async()=>{
 assert.equal(typeof instrumentPool,'function');
 const metrics=createPerformanceMetrics();let released=0;
 const client={query(sql,callback){const error=sql==='fail'?new Error('secret'):null;if(callback){callback(error,error?undefined:{rows:[1]});return}return error?Promise.reject(error):Promise.resolve({rows:[1]})},release(){released++}};
 const pool={connect(callback){if(callback){callback(null,client,()=>client.release());return}return Promise.resolve(client)}};
 instrumentPool(pool,metrics,()=>1);
 const c=await pool.connect();assert.deepEqual(await c.query('secret SQL'),{rows:[1]});
 await assert.rejects(()=>c.query('fail'),/secret/);c.release();
 await new Promise((resolve,reject)=>pool.connect((err,c,release)=>{if(err)return reject(err);c.query('select',(error,result)=>{assert.equal(error,null);assert.deepEqual(result,{rows:[1]});release();resolve()})}));
 assert.equal(released,2);
 assert.equal(metrics.snapshot()['db.acquire'].count,2);
 assert.equal(metrics.snapshot()['db.query'].count,3);
 assert.equal(metrics.snapshot()['db.query'].failures,1);
 assert.ok(!JSON.stringify(metrics.snapshot()).includes('secret'));
});
