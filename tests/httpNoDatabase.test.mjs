import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';

// Network-level smoke without PostgreSQL: only endpoints that must not read/write it.
test('public health, CORS, authentication and client marker boundaries', async () => {
  const server=app.listen(0,'127.0.0.1');
  try {
    await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    const base=`http://127.0.0.1:${server.address().port}`;
    const health=await fetch(`${base}/health`);
    assert.equal(health.status,200);
    assert.equal((await health.json()).service,'zenix-pos-api');
    const guestSession=await fetch(`${base}/api/auth/session`);
    assert.equal(guestSession.status,200,'guest session bootstrap should not log an HTTP 401');
    assert.equal(guestSession.headers.get('cache-control'),'no-store','session status must never be cached');
    const guestBody=await guestSession.json();
    assert.equal(guestBody.ok,true);
    assert.deepEqual(guestBody.data,{user:null},'guest status must not expose tenant data');
    const protectedMe=await fetch(`${base}/api/auth/me`);
    assert.equal(protectedMe.status,401,'original protected identity endpoint must still reject guests');
    const anonymous=await fetch(`${base}/api/products`);
    assert.equal(anonymous.status,401,'unauthenticated tenant data must not be exposed');
    const forbiddenOrigin=await fetch(`${base}/api/products`,{headers:{origin:'https://other-site.invalid'}});
    assert.equal(forbiddenOrigin.status,403,'unexpected cross-origin browser requests must be refused');
    const untrustedWrite=await fetch(`${base}/api/auth/login`,{
      method:'POST',headers:{'content-type':'application/json',origin:'http://localhost:5173'},
      body:JSON.stringify({username:'smoke',password:'smoke'}),
    });
    assert.equal(untrustedWrite.status,403,'browser writes without Zenix client marker must be refused');
  } finally {
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  }
});
