// Actual wire bytes and decode/parse latency against disposable populated fixture.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {get} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {writeFile,mkdir} from 'node:fs/promises';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;assertSafeTestDatabaseUrl(url);assert.equal(process.env.DATABASE_URL,url);assert.equal(process.env.NODE_ENV,'test');
const [{app},{pool},{sha256}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js')]);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
try{
 const user=(await pool.query("SELECT u.id FROM users u JOIN organizations o ON o.id=u.organization_id WHERE o.name='Populated inventory synthetic benchmark' AND u.app_role='OWNER' ORDER BY u.created_at LIMIT 1")).rows[0];assert.ok(user,'populated fixture required');
 const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user.id,sha256(token)]);
 const samples=[],paired=process.argv.includes('--paired');
 for(let i=0;i<(paired?66:33);i++){
  const began=performance.now();
  const result=await new Promise((resolve,reject)=>{
   const request=get(`http://127.0.0.1:${server.address().port}/api/bootstrap`,{headers:{cookie:`zenix_session=${token}`,'x-zenix-client':'web',origin:'http://localhost:5173','accept-encoding':paired&&i%2?'identity':'gzip'}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,encoding:res.headers['content-encoding'],body:Buffer.concat(chunks)}));
   });request.setTimeout(30000,()=>request.destroy(new Error('benchmark timeout')));request.on('error',reject);
  });
  assert.equal(result.status,200);
  const decoded=result.encoding==='gzip'?gunzipSync(result.body):result.body,body=JSON.parse(decoded);
  assert.equal(body.data.inventory.length,50000);assert.ok(body.data.inventory.every(p=>Object.values(p.stockByStore).every(q=>Number(q)===100)));
  if(i>=(paired?6:3))samples.push({ms:performance.now()-began,wireBytes:result.body.length,decodedBytes:decoded.length,encoding:result.encoding||'identity'});
 }
 const stats=rows=>{const times=rows.map(s=>s.ms).sort((a,b)=>a-b);return {samples:rows.length,p50:times[Math.ceil(times.length*.5)-1],p95:times[Math.ceil(times.length*.95)-1],p99:times.at(-1),wireBytes:rows.at(-1).wireBytes,decodedBytes:rows.at(-1).decodedBytes}};
 const result={mode:paired?'paired':process.argv.includes('--baseline')?'baseline':'optimized',...stats(samples),encoding:samples.at(-1).encoding,...(paired?{identity:stats(samples.filter(s=>s.encoding==='identity')),gzip:stats(samples.filter(s=>s.encoding==='gzip'))}:{}),note:'Local HTTP end-to-end includes JSON decoding/parsing; no network throttling; full 50k product data retained',raw:samples};
 await mkdir('.cache/performance',{recursive:true});await writeFile(`.cache/performance/bootstrap-wire-${result.mode}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,raw:undefined}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end()}
