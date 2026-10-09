import test from 'node:test';
import assert from 'node:assert/strict';
import { requireActiveLicense, requireAuth } from '../src/middleware/auth.js';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { lockValidPromo } from '../src/services/promoCodes.js';

test('trial ends at its exact server timestamp even on a valid license date',()=>{
  let error;
  requireActiveLicense({user:{licenseStatus:'ACTIVE',licenseDateValid:true,organizationSettings:{trialEndsAt:'2020-01-01T12:00:00Z'}}},{},value=>{error=value});
  assert.equal(error?.code,'LICENSE_EXPIRED');
});
test('restored sessions retain mandatory password change and block operational calls',async()=>{
  const original=pool.query;
  pool.query=async()=>({rows:[{id:'user',active:true,must_change_password:true,organization_id:'org',license_status:'ACTIVE',last_seen_at:new Date()}]});
  try {
    const req={cookies:{[env.sessionCookieName]:'session'},originalUrl:'/api/auth/me'};
    let error;
    await requireAuth(req,{},value=>{error=value});
    assert.equal(error,undefined);
    assert.equal(req.user.forcePasswordChange,true);
    req.originalUrl='/api/products';
    await requireAuth(req,{},value=>{error=value});
    assert.equal(error?.code,'PASSWORD_CHANGE_REQUIRED');
  } finally {pool.query=original;}
});
test('a scheduled promo cannot be redeemed before its start',async()=>{
  const client={query:async(sql)=>({rows:sql.includes('SELECT *')?[{id:'promo',active:true,starts_at:'2099-01-01T00:00:00Z',plan:'BOTH',used_count:0,max_uses:5,max_uses_per_org:1}]:[{n:0}]})};
  await assert.rejects(()=>lockValidPromo(client,{code:'FUTURE',plan:'MONTHLY',organizationId:'org'}),{code:'PROMO_NOT_STARTED'});
});
