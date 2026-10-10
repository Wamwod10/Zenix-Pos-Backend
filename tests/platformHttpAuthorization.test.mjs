import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import platform from '../src/routes/platform.js';
import {pool} from '../src/db/pool.js';
import {env} from '../src/config/env.js';
import {errorHandler} from '../src/middleware/error.js';

test('HTTP platform boundaries reject tenant users even with forged permission overrides',async()=>{
 const original=pool.query;let calls=0;
 pool.query=async()=>{calls++;return {rows:[{id:'owner',organization_id:'tenant',app_role:'OWNER',active:true,license_status:'ACTIVE',last_seen_at:new Date(),permission_overrides:{platformAdmin:true}}]}};
 const app=express();app.use((req,_res,next)=>{req.cookies={[env.sessionCookieName]:'tenant-session'};next()});app.use('/api/platform',platform);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const base=`http://127.0.0.1:${server.address().port}/api/platform`;
  for(const path of ['/overview','/promos','/organizations/11111111-1111-4111-8111-111111111111/support','/audit-logs']){
   const response=await fetch(base+path);assert.equal(response.status,403);assert.equal((await response.json()).error.code,'FORBIDDEN');
  }
  assert.equal(calls,4,'only authentication reads are allowed; no platform query is reached');
 }finally{pool.query=original;await new Promise(r=>server.close(r))}
});
