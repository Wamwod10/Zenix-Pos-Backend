import { randomUUID } from 'node:crypto';
import {pool} from '../db/pool.js';
import {writeAudit} from '../services/audit.js';

// Trace slow/failed requests without recording bodies, auth cookies, query
// strings or URL path parameters (those can contain sensitive tenant data).
export function createRequestTelemetry({ logger=console,slowMs=2000,clock=()=>Date.now(),makeId=randomUUID,persist }={}){
  return (req,res,next)=>{
    const requestId=makeId();
    const began=clock();
    req.requestId=requestId;
    res.setHeader('X-Request-Id',requestId);
    res.once('finish',()=>{
      const elapsed=Math.max(0,clock()-began);
      if(res.statusCode<500&&elapsed<slowMs)return;
      logger.warn(JSON.stringify({event:res.statusCode>=500?'request_error':'slow_request',requestId,method:req.method,status:res.statusCode,elapsedMs:elapsed}));
      if(persist&&req.user?.organizationId){
        Promise.resolve().then(()=>persist({organizationId:req.user.organizationId,userId:req.user.id,action:res.statusCode>=500?'api_error':'api_slow',entityType:'request',entityId:requestId,title:res.statusCode>=500?'API xatosi':'Sekin API so‘rovi',metadata:{requestId,method:req.method,status:res.statusCode,elapsedMs:elapsed,route:typeof req.route?.path==='string'?req.route.path:null}})).catch(()=>logger.warn(JSON.stringify({event:'telemetry_persistence_failed',requestId})));
      }
    });
    next();
  };
}
export const requestTelemetry=createRequestTelemetry({persist:entry=>writeAudit(pool,entry)});
