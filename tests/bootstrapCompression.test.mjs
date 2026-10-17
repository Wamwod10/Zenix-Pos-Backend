import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
const {createBootstrapSender}=await import('../src/lib/bootstrapResponse.js').catch(()=>({}));
const request=gzip=>({acceptsEncodings:()=>gzip?'gzip':false,app:{get:()=>undefined}});
const response=()=>({headers:{},status(){return this},json(value){this.value=value;return this},type(){return this},vary(name){this.headers.vary=name;return this},set(name,value){this.headers[name]=value;return this},send(body){this.body=body;return this}});
test('bootstrap compression preserves exact financial JSON and negotiates gzip',async()=>{
 assert.equal(typeof createBootstrapSender,'function');
 const send=createBootstrapSender({threshold:1}),data={total:'90071992547410.03',quantity:'1.250',name:'<script>'+'.'.repeat(500)};
 const compressed=response();await send(request(true),compressed,data);
 assert.equal(compressed.headers['Content-Encoding'],'gzip');assert.equal(compressed.headers.vary,'Accept-Encoding');
 assert.deepEqual(JSON.parse(gunzipSync(compressed.body)),{ok:true,data});
 const plain=response();await send(request(false),plain,data);assert.deepEqual(plain.value,{ok:true,data});
});
test('compression concurrency is bounded and failures retain the complete response',async()=>{
 assert.equal(typeof createBootstrapSender,'function');let resolve;
 const send=createBootstrapSender({threshold:1,maxConcurrent:1,compress:()=>new Promise(r=>resolve=r)}),first=response(),second=response();
 const pending=send(request(true),first,{x:1});await send(request(true),second,{x:2});
 assert.deepEqual(second.value,{ok:true,data:{x:2}});resolve(Buffer.from('compressed'));await pending;
 const fallback=response();await createBootstrapSender({threshold:1,compress:async()=>{throw new Error('compression failure')}})(request(true),fallback,{total:'12.34'});
 assert.deepEqual(JSON.parse(fallback.body),{ok:true,data:{total:'12.34'}});
});

test('HTTP gzip q=0 and Express JSON escaping/replacer settings are preserved',async()=>{
 const {default:express}=await import('express'),app=express();
 app.set('json escape',true);app.set('json spaces',2);app.set('json replacer',(key,value)=>key==='omit'?undefined:value);
 const send=createBootstrapSender({threshold:1}),data={total:'12.34',name:'<>&'+'.'.repeat(1000),omit:'private'};
 app.get('/',(req,res,next)=>send(req,res,data).catch(next));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/`;
  const gzip=await fetch(url,{headers:{'accept-encoding':'gzip'}}),text=await gzip.text();
  assert.equal(gzip.headers.get('content-encoding'),'gzip');assert.ok(text.includes('\\u003c'));
  const plain=await fetch(url,{headers:{'accept-encoding':'gzip;q=0, identity'}});
  assert.equal(plain.headers.get('content-encoding'),null);assert.deepEqual(await plain.json(),JSON.parse(text));
  assert.equal(JSON.parse(text).data.omit,undefined);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
});
