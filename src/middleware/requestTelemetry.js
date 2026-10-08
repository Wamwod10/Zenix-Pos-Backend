import { randomUUID } from 'node:crypto';

// Trace slow/failed requests without recording bodies, auth cookies, query
// strings or URL path parameters (those can contain sensitive tenant data).
export function createRequestTelemetry({ logger=console,slowMs=2000,clock=()=>Date.now(),makeId=randomUUID }={}){
  return (req,res,next)=>{
    const requestId=makeId();
    const began=clock();
    req.requestId=requestId;
    res.setHeader('X-Request-Id',requestId);
    res.once('finish',()=>{
      const elapsed=Math.max(0,clock()-began);
      if(res.statusCode<500&&elapsed<slowMs)return;
      logger.warn(JSON.stringify({event:res.statusCode>=500?'request_error':'slow_request',requestId,method:req.method,status:res.statusCode,elapsedMs:elapsed}));
    });
    next();
  };
}
export const requestTelemetry=createRequestTelemetry();
