// Synthetic serialization CPU benchmark; no database imports or network calls.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
const optimized=process.argv.includes('--optimized');
const legacy=(value,timeZone='Asia/Tashkent')=>{
 const date=value?new Date(value):new Date();
 const dateISO=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
 const dateText=new Intl.DateTimeFormat('uz-UZ',{timeZone,day:'2-digit',month:'2-digit',year:'numeric'}).format(date);
 const time=new Intl.DateTimeFormat('uz-UZ',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
 return {dateISO,date:dateText,time};
};
const factory=optimized?(await import('../src/lib/bootstrapDates.js')).createBootstrapDateParts:null;
const dates=Array.from({length:1000},(_,i)=>new Date(1767225600000+i*3600000).toISOString());
const run=()=>{const format=optimized?factory('Asia/Tashkent'):legacy;return dates.map(date=>format(date))};
assert.deepEqual(run(),dates.map(date=>legacy(date)));
for(let i=0;i<3;i++)run();
const samples=[];
for(let i=0;i<30;i++){const start=performance.now();run();samples.push(performance.now()-start)}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({mode:optimized?'request-scoped':'baseline',rows:dates.length,samples:samples.length,p50:samples[14],p95:samples[28],p99:samples[29]}));
