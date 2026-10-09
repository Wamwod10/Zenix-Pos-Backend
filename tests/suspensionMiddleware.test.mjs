import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { requireAuth, requireActiveLicense } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/error.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

test('pre-route suspension uses ACCOUNT_SUSPENDED while license failures retain payment codes',async()=>{
  const original=pool.query;
  let row={id:'user',organization_id:'org',active:true,license_status:'SUSPENDED',last_seen_at:new Date(),expires_at:new Date(Date.now()+60000)};
  pool.query=async()=>({rows:[row]});
  const app=express();let reached=0;
  app.use((req,_res,next)=>{req.cookies={[env.sessionCookieName]:'test-session'};next();});
  app.get('/protected',requireAuth,requireActiveLicense,(_req,res)=>{reached++;res.json({ok:true});});
  app.get('/license',(req,_res,next)=>{req.user={organizationId:'org',licenseStatus:row.license_status,licenseDateValid:row.license_date_valid,organizationSettings:row.organization_settings};next();},requireActiveLicense,(_req,res)=>res.json({ok:true}));
  app.use(errorHandler);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const path of ['/protected','/license']){
      const response=await fetch(base+path);assert.equal(response.status,403);assert.equal((await response.json()).error.code,'ACCOUNT_SUSPENDED');
    }
    assert.equal(reached,0);
    for(const [status,dateValid,settings,code] of [
      ['PAYMENT_REQUIRED',true,{},'PAYMENT_REQUIRED'],['REVIEW',true,{},'LICENSE_REVIEW'],['EXPIRED',false,{},'LICENSE_EXPIRED'],
      ['ACTIVE',false,{},'LICENSE_EXPIRED'],['ACTIVE',true,{billingHold:true},'BILLING_HOLD'],
    ]){
      row={...row,license_status:status,license_date_valid:dateValid,organization_settings:settings};
      const response=await fetch(base+'/protected');assert.equal(response.status,402);assert.equal((await response.json()).error.code,code);
    }
  }finally{pool.query=original;await new Promise(resolve=>server.close(resolve));}
});
