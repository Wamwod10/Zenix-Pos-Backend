// Read-only public readiness smoke: fixed Zenix origin, no credentials, no writes.
import {pathToFileURL} from 'node:url';
export const BASE='https://zenix-pos-backend.onrender.com';
export async function probeZenixPublicHealth(fetcher=fetch){
 const results=[];
 for(const path of ['/health','/ready']){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
   const response=await fetcher(BASE+path,{method:'GET',redirect:'error',signal:controller.signal,headers:{accept:'application/json','cache-control':'no-cache'}});
   const type=response.headers?.get?.('content-type')||'';
   let payload={};
   if(type.includes('application/json')){try{payload=await response.json();}catch{}}
   const valid=response.status===200 && payload?.ok===true && payload?.service==='zenix-pos-api' && (path!=='/ready'||payload.database==='ready');
   results.push({path,status:response.status,healthy:valid,database:path==='/ready'?(payload.database||'unknown'):undefined});
  }catch(error){results.push({path,healthy:false,error:error?.name==='AbortError'?'timeout':'unreachable'});}
  finally{clearTimeout(timer)}
 }
 return {origin:BASE,checks:results,allHealthy:results.every(x=>x.healthy===true),probedAt:new Date().toISOString(),requests:'GET only'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await probeZenixPublicHealth();console.log(JSON.stringify(result,null,2));
 if(!result.allHealthy)process.exitCode=1;
}
