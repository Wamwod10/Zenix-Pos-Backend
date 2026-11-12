import test from 'node:test';
import assert from 'node:assert/strict';
import {probeZenixPublicHealth,BASE} from '../scripts/probeProductionHealth.mjs';
const fake=(status=200,good=true)=>async(url,opts)=>({
 status,headers:{get:()=> 'application/json'},
 json:async()=>({ok:good,service:'zenix-pos-api',database:'ready'}),
});
test('health probe uses only GET and fixed production origin',async()=>{
 const calls=[];
 const res=await probeZenixPublicHealth(async(url,opts)=>{calls.push({url,method:opts.method});return fake()(url,opts)});
 assert.equal(res.allHealthy,true);
 assert.deepEqual(calls,[{url:BASE+'/health',method:'GET'},{url:BASE+'/ready',method:'GET'}]);
});
test('health check fails closed on non-200, invalid body or network interruption',async()=>{
 assert.equal((await probeZenixPublicHealth(fake(503))).allHealthy,false);
 assert.equal((await probeZenixPublicHealth(fake(200,false))).allHealthy,false);
 assert.equal((await probeZenixPublicHealth(async()=>{throw Error('network')})).allHealthy,false);
});
