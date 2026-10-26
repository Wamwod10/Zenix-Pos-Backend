import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import users from '../src/routes/users.js';
import {pool} from '../src/db/pool.js';
import {env} from '../src/config/env.js';
import {errorHandler} from '../src/middleware/error.js';

test('HTTP employee administration protects owner identity from delegated settings writers',async()=>{
 const originalQuery=pool.query,originalConnect=pool.connect;
 const ownerId='11111111-1111-4111-8111-111111111111';
 const staffId='22222222-2222-4222-8222-222222222222';
 let actorRole='ADMIN',targetRole='OWNER',writes=0;
 const target=()=>({id:targetRole==='OWNER'?ownerId:staffId,organization_id:'org',store_id:'33333333-3333-4333-8333-333333333333',app_role:targetRole,name:'Existing user',username:'existing',phone:'998901234567',active:true,permission_overrides:{}});
 pool.query=async()=>({rows:[{id:actorRole==='OWNER'?ownerId:'44444444-4444-4444-8444-444444444444',organization_id:'org',app_role:actorRole,active:true,license_status:'ACTIVE',subscription_writable:true,last_seen_at:new Date(),permission_overrides:{settingsWrite:true}}]});
 pool.connect=async()=>({release(){},async query(sql,args){
  if(sql.includes('subscription_can_write'))return {rows:[{writable:true}]};
  if(sql.includes('SELECT * FROM users'))return {rows:[target()]};
  if(sql.startsWith('UPDATE users')){writes++;return {rows:[{...target(),name:args[2],username:args[3],phone:args[4],app_role:args[5],store_id:args[6],active:args[7]}]};}
  return {rows:[],rowCount:1};
 }});
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.cookies={[env.sessionCookieName]:'synthetic-session'};next()});app.use('/api/users',users);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const patch=body=>fetch(`http://127.0.0.1:${server.address().port}/api/users/${target().id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  for(actorRole of ['ADMIN','MANAGER','CASHIER','SALES','WAREHOUSE']){
   for(const body of [{name:'Changed name'},{username:'changed-login'},{phone:'998909999999'},{storeId:null},{active:true},{appRole:'MANAGER'}]){
    const response=await patch(body);assert.equal(response.status,403,`${actorRole}: ${JSON.stringify(body)}`);assert.equal((await response.json()).error.code,'OWNER_PROTECTED');
   }
  }
  assert.equal(writes,0,'denied requests must not reach user updates');
  actorRole='OWNER';assert.equal((await patch({name:'Owner updated'})).status,200);
  actorRole='ADMIN';targetRole='MANAGER';assert.equal((await patch({name:'Staff updated'})).status,200);
  assert.equal(writes,2);
  assert.equal((await patch({appRole:'SALES',permissionOverrides:{}})).status,403,'delegated role edit must not write owner-only overrides');
  assert.equal(writes,2);
  assert.equal((await patch({appRole:'SALES'})).status,200,'delegated role edit without overrides remains supported');
  assert.equal(writes,3);
 }finally{pool.query=originalQuery;pool.connect=originalConnect;await new Promise(resolve=>server.close(resolve));}
});
