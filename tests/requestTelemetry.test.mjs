import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequestTelemetry} from '../src/middleware/requestTelemetry.js';

test('request telemetry exposes correlation ID but never logs session or body data',()=>{
 const entries=[];
 let now=1000;
 const middleware=createRequestTelemetry({logger:{warn:(entry)=>entries.push(JSON.parse(entry))},clock:()=>now,makeId:()=> 'trace-abc',slowMs:2000});
 const req={method:'POST',path:'/api/auth/login',url:'/api/auth/login?token=SECRET',body:{password:'SECRET'},headers:{cookie:'SECRET'}};
 const res=new EventEmitter();res.statusCode=500;res.setHeader=(name,value)=>{res[name]=value};
 middleware(req,res,()=>{});
 now=1300;res.emit('finish');
 assert.equal(req.requestId,'trace-abc');
 assert.equal(res['X-Request-Id'],'trace-abc');
 assert.equal(entries[0].event,'request_error');
 assert.equal(JSON.stringify(entries).includes('SECRET'),false);
 assert.equal(JSON.stringify(entries).includes('token'),false);
});
test('support diagnostics persist only sanitized authenticated tenant errors',async()=>{
 const records=[];
 const middleware=createRequestTelemetry({logger:{warn:()=>{}},persist:async value=>records.push(value),makeId:()=> 'trace-safe'});
 const req={method:'POST',user:{id:'user',organizationId:'org'},route:{path:'/:id'},body:{password:'SECRET'},originalUrl:'/api/payments/SECRET?token=SECRET'};
 const res=new EventEmitter();res.statusCode=500;res.setHeader=()=>{};
 middleware(req,res,()=>{});res.emit('finish');await Promise.resolve();
 assert.equal(records.length,1);
 assert.equal(records[0].organizationId,'org');
 assert.equal(JSON.stringify(records).includes('SECRET'),false);
});
