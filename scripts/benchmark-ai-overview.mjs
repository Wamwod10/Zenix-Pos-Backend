// Deterministic adapter roundtrip benchmark, not OpenAI or real SQL latency.
import {readAgentReport} from '../src/services/aiReadReports.js';
import {performance} from 'node:perf_hooks';
import {mkdir,writeFile} from 'node:fs/promises';
const user={id:'synthetic-owner',organizationId:'synthetic-org',appRole:'OWNER',permissionOverrides:{},rolePermissions:{}};
const samples=[];let lastCalls=[];
for(let i=0;i<35;i++){
 const calls=[];
 const db={async query(sql){calls.push(sql);await new Promise(resolve=>setTimeout(resolve,2));
  if(sql.startsWith('SELECT timezone'))return {rows:[{timezone:'Asia/Tashkent',settings:{}}]};
  if(sql.startsWith('WITH a AS'))return {rows:[]};
  return {rows:[{count:'0',gross:'0',refunds:'0',amount:'0',catalog:'0',available:'0',low:'0',stores:'0',warehouses:'0',unassigned:'0'}]};
 }};
 const began=performance.now();await readAgentReport(db,user,'get_business_overview',{storeId:null});
 if(i>=5)samples.push(performance.now()-began);lastCalls=calls;
}
samples.sort((a,b)=>a-b);
const result={environment:'synthetic 2ms adapter delay per query, no network/model',samples:samples.length,queries:lastCalls.length,organizationReads:lastCalls.filter(s=>s.startsWith('SELECT timezone')).length,p50:samples[14],p95:samples[28],p99:samples[29]};
await mkdir('.cache/performance',{recursive:true});
await writeFile(`.cache/performance/ai-overview-${process.argv.includes('--baseline')?'before':'after'}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
