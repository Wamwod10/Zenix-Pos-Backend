import test from "node:test";
import assert from "node:assert/strict";
import {createAdminAlertSmokeGate} from "../src/services/adminAlertSmokeGate.js";

test("admin alert test requires configured admin destination, single-flight and cooldown",async()=>{
  let time=1000, sends=0, finish;
  const send=()=>{sends++;return new Promise(resolve=>{finish=resolve})};
  const trigger=createAdminAlertSmokeGate({send,now:()=>time,successCooldownMs:300000,failureCooldownMs:60000});
  assert.deepEqual(await trigger({token:"",chatId:"admin"}),{ok:false,reason:"missing_configuration"});
  const pending=trigger({token:"synthetic-token",chatId:"synthetic-admin"});
  assert.deepEqual(await trigger({token:"synthetic-token",chatId:"synthetic-admin"}),{ok:false,reason:"rate_limited"});
  assert.equal(sends,1);
  finish({ok:true,reason:"telegram_accepted"});
  assert.deepEqual(await pending,{ok:true,reason:"telegram_accepted"});
  assert.deepEqual(await trigger({token:"synthetic-token",chatId:"synthetic-admin"}),{ok:false,reason:"rate_limited"});
  time+=300000;
  const second=trigger({token:"synthetic-token",chatId:"synthetic-admin"});
  finish({ok:false,reason:"transport_rejected"});
  assert.deepEqual(await second,{ok:false,reason:"transport_rejected"});
  time+=60000;
  const third=trigger({token:"synthetic-token",chatId:"synthetic-admin"});
  finish({ok:true,reason:"telegram_accepted"});
  assert.equal((await third).ok,true);
  assert.equal(sends,3);
});

test("admin test transport exception fails closed without exposing secret",async()=>{
  const trigger=createAdminAlertSmokeGate({send:async()=>{throw new Error("synthetic-secret")},now:()=>123});
  const result=await trigger({token:"synthetic-secret",chatId:"admin"});
  assert.deepEqual(result,{ok:false,reason:"transport_unavailable"});
  assert.doesNotMatch(JSON.stringify(result),/synthetic-secret/);
});
