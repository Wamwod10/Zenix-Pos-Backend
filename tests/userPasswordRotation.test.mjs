import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import users from '../src/routes/users.js';
import {pool} from '../src/db/pool.js';
import {env} from '../src/config/env.js';
import {errorHandler} from '../src/middleware/error.js';

test('forced password rotation rejects reusing the current password and preserves sessions on rejection',async()=>{
 const originalQuery=pool.query,originalConnect=pool.connect;
 const userId='11111111-1111-4111-8111-111111111111',orgId='22222222-2222-4222-8222-222222222222';
 let passwordHash=await bcrypt.hash('OldPassword123!',4),forced=true,writes=0,sessionRevocations=0;
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{req.cookies={[env.sessionCookieName]:'fake-session'};next()});
 app.use('/api/users',users);app.use(errorHandler);
 pool.query=async(sql)=>{
  if(sql.includes('FROM auth_sessions s'))return {rows:[{id:userId,session_id:'33333333-3333-4333-8333-333333333333',organization_id:orgId,app_role:'CASHIER',active:true,license_status:'ACTIVE',subscription_writable:true,must_change_password:forced,last_seen_at:new Date()}]};
  return {rows:[],rowCount:0};
 };
 pool.connect=async()=>({release(){},async query(sql,args){
  if(sql.includes('subscription_can_write'))return {rows:[{writable:true}]};
  if(sql.includes('SELECT * FROM users WHERE id='))return {rows:[{id:userId,organization_id:orgId,password_hash:passwordHash,must_change_password:forced}]};
  if(sql.startsWith('UPDATE users SET password_hash')){writes++;passwordHash=args[2];forced=false;return {rowCount:1,rows:[]};}
  if(sql.startsWith('UPDATE auth_sessions SET revoked_at')){sessionRevocations++;return {rowCount:1,rows:[]};}
  return {rows:[{id:orgId}],rowCount:1};
 }});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const change=async(currentPassword,newPassword)=>{
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/users/me/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword,newPassword})});
  return {status:response.status,body:await response.json()};
 };
 try{
  const same=await change('OldPassword123!','OldPassword123!');
  assert.equal(same.status,400,JSON.stringify(same.body));
  assert.equal(same.body.error.code,'PASSWORD_REUSE_FORBIDDEN');
  assert.equal(writes,0);
  assert.equal(sessionRevocations,0);
  assert.equal(forced,true);
  const changed=await change('OldPassword123!','NewPassword456!');
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  assert.equal(writes,1);
  assert.equal(sessionRevocations,1);
  assert.equal(forced,false);
  assert.equal(await bcrypt.compare('NewPassword456!',passwordHash),true);
 }finally{
  pool.query=originalQuery;pool.connect=originalConnect;
  await new Promise(resolve=>server.close(resolve));
 }
});
