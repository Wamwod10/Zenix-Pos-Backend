import test from 'node:test';
import assert from 'node:assert/strict';
import {issuePasswordReset,consumePasswordReset} from '../src/services/passwordReset.js';
import {sha256} from '../src/lib/crypto.js';

test('reset token is hashed, tenant scoped and rate limited',async()=>{
  const calls=[];
  const db={query:async(sql,args)=>{calls.push([sql,args]);return {rows:sql.includes('count(*)')?[{n:0}]:[{id:'user'}],rowCount:1}}};
  const result=await issuePasswordReset(db,{organizationId:'org',userId:'user',actorId:'admin',reason:'Identity verified',identityVerified:true});
  assert.ok(result.token.length>=40);
  const inserted=calls.find(([sql])=>sql.includes('INSERT INTO password_reset_tokens'));
  assert.equal(inserted[1][1],sha256(result.token));
  assert.ok(!JSON.stringify(calls).includes(result.token));
  await assert.rejects(()=>issuePasswordReset(db,{organizationId:'org',userId:'user',identityVerified:false}),{code:'IDENTITY_REQUIRED'});
});
test('expired and already used tokens cannot change credentials',async()=>{
  for(const token of [{expires_at:'2000-01-01',consumed_at:null},{expires_at:'2099-01-01',consumed_at:new Date()}]){
    const calls=[];
    const db={query:async sql=>{calls.push(sql);return {rows:[{id:'token',user_id:'user',organization_id:'org',...token}]}}};
    await assert.rejects(()=>consumePasswordReset(db,{token:'a'.repeat(43),passwordHash:'hash'}),{code:'RESET_TOKEN_INVALID'});
    assert.ok(!calls.some(sql=>sql.startsWith('UPDATE users')));
  }
});
test('reset issuance rejects a foreign user and enforces the per-user time window',async()=>{
 const missing={query:async sql=>({rows:sql.includes('FROM users')?[]:[{id:'org'}]})};
 await assert.rejects(()=>issuePasswordReset(missing,{organizationId:'org',userId:'foreign',identityVerified:true}),{code:'USER_NOT_FOUND'});
 const limited={query:async sql=>({rows:sql.includes('count(*)')?[{n:3}]:[{id:'user'}]})};
 await assert.rejects(()=>issuePasswordReset(limited,{organizationId:'org',userId:'user',identityVerified:true}),{code:'RESET_RATE_LIMITED'});
});
