// Opt-in in-process diagnostics. Fixed memory; no payloads, SQL, identifiers or logs.
export function createPerformanceMetrics({enabled=true,maxKeys=128,windowSize=256}={}){
 if(!Number.isInteger(maxKeys)||maxKeys<1||maxKeys>128||!Number.isInteger(windowSize)||windowSize<1||windowSize>2048)throw new Error('Invalid metrics bounds');
 const series=new Map();
 return {
  enabled,
  observe(key,duration,{failed=false}={}){
   if(!enabled||typeof key!=='string'||key.length>200||!Number.isFinite(duration)||duration<0)return;
   let row=series.get(key);
   if(!row){if(series.size>=maxKeys)return;row={count:0,failures:0,values:[]};series.set(key,row)}
   row.values[row.count%windowSize]=duration;row.count++;if(failed)row.failures++;
  },
  snapshot(){
   return Object.fromEntries([...series].map(([key,row])=>{
    const sorted=[...row.values].sort((a,b)=>a-b),percentile=p=>sorted[Math.ceil(sorted.length*p)-1];
    return [key,{count:row.count,failures:row.failures,windowSamples:sorted.length,p50:percentile(.5),p95:percentile(.95),p99:percentile(.99)}];
   }));
  },
  reset(){series.clear()},
 };
}
export const performanceMetrics=createPerformanceMetrics({enabled:process.env.ZENIX_PERFORMANCE_METRICS==='true'});
