import {performanceMetrics} from './performanceMetrics.js';
export function createPerformanceTimer(metrics=performanceMetrics,clock=()=>performance.now()){
 return (label,work)=>{
  if(!metrics.enabled)return work();
  const start=clock();let recorded=false;
  const observe=failed=>{if(!recorded){recorded=true;metrics.observe(label,clock()-start,{failed});}};
  try{
   const value=work();
   if(typeof value?.then==='function')return Promise.resolve(value).then(result=>{observe(false);return result},error=>{observe(true);throw error});
   observe(false);return value;
  }catch(error){observe(true);throw error;}
 };
}
export const measurePerformance=createPerformanceTimer();
