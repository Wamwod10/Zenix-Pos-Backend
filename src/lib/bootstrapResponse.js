import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {ok} from './http.js';
import {performanceMetrics} from './performanceMetrics.js';
const gzipAsync=promisify(gzip);

// Large read-only bootstrap only. Bound extra CPU/memory; no auth/AI/token responses.
export function createBootstrapSender({threshold=65536,maxBytes=32*1024*1024,maxConcurrent=2,compress=body=>gzipAsync(body,{level:1})}={}){
 let active=0;
 return async(req,res,data)=>{
  res.vary('Accept-Encoding');
  if(req.acceptsEncodings('gzip')!=='gzip'||active>=maxConcurrent)return ok(res,data);
  const app=req.app,escape=app.get('json escape');
  const serializeStarted=performanceMetrics.enabled?performance.now():0;
  let body=JSON.stringify({ok:true,data},app.get('json replacer'),app.get('json spaces'));
  if(escape)body=body.replace(/[<>&]/g,char=>({'<':'\\u003c','>':'\\u003e','&':'\\u0026'}[char]));
  performanceMetrics.observe('bootstrap.serialize',performance.now()-serializeStarted);
  const bytes=Buffer.byteLength(body),plain=()=>res.status(200).type('application/json').send(body);
  if(bytes<threshold||bytes>maxBytes)return plain();
  let compressed,failed=false;
  const compressionStarted=performanceMetrics.enabled?performance.now():0;
  active++;
  try{compressed=await compress(body)}catch{failed=true;return plain()}finally{active--;performanceMetrics.observe('bootstrap.compress',performance.now()-compressionStarted,{failed});}
  if(compressed.length>=bytes)return plain();
  return res.status(200).type('application/json').set('Content-Encoding','gzip').send(compressed);
 };
}
export const sendBootstrap=createBootstrapSender();
