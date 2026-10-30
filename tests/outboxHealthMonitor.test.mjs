import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxHealthMonitor, summarizeOutboxHealth, OUTBOX_HEALTH_SQL } from "../src/services/outboxHealthMonitor.js";

test("worker monitor alerts on failed/stale aggregate without any tenant identifiers, throttles and recovers",async()=>{
  let now=100_000;
  const notices=[],warns=[];
  let state={outbox_failed:2,delivery_failed:1,stale_outbox:3,stale_deliveries:0};
  const check=createOutboxHealthMonitor({
    query:async(sql)=>{assert.match(sql,/SELECT/);assert.doesNotMatch(sql,/UPDATE|DELETE|INSERT/i);return {rows:[state]}},
    send:async(message)=>{notices.push(message);return true},
    now:()=>now,warn:x=>warns.push(x),error:()=>assert.fail("unexpected error"),cooldownMs:60_000
  });
  assert.deepEqual(summarizeOutboxHealth(state),{failed:3,stale:3});
  await check();await check();
  assert.equal(notices.length,1,"repeat anomaly is throttled");
  assert.match(notices[0],/Xato xabarlar: 3/);
  assert.doesNotMatch(notices[0],/organization_id|chat_id|paymentId/);
  now+=61_000;
  await check();
  assert.equal(notices.length,2,"sustained incidents remind at a bounded interval");
  state={outbox_failed:0,delivery_failed:0,stale_outbox:0,stale_deliveries:0};
  await check();
  assert.equal(notices.length,3);
  assert.match(notices.at(-1),/tiklandi/);
  assert.match(OUTBOX_HEALTH_SQL,/notification_deliveries/);
});

test("planned financial maintenance does not send a false alarm",async()=>{
  const notices=[],warnings=[];
  const check=createOutboxHealthMonitor({
    query:async()=>{throw new Error("ZENIX cutover in progress: financial writes paused")},
    send:async(x)=>{notices.push(x);return true},
    warn:x=>warnings.push(x),error:()=>assert.fail("not a hard failure")
  });
  await check();await check();
  assert.equal(notices.length,0);
  assert.equal(warnings.length,1,"no repetitive maintenance log storm");
});

test("repeated genuine database failures generate one privacy-safe admin alert",async()=>{
  const notices=[],errors=[];
  const check=createOutboxHealthMonitor({
    query:async()=>{throw new Error("customer-db-detail-should-not-leak")},
    send:async(x)=>{notices.push(x);return true},
    warn:()=>{},error:x=>errors.push(x)
  });
  await check();await check();await check();
  assert.equal(notices.length,1);
  assert.doesNotMatch(notices[0],/customer-db-detail/);
  assert.ok(errors.every(e=>!e.includes("customer-db-detail")));
});

test("overlapping timer ticks cannot duplicate alert checks",async()=>{
  let release,reads=0;
  const check=createOutboxHealthMonitor({
    query:()=>{reads++;return new Promise(resolve=>{release=resolve})},
    send:async()=>true,warn:()=>{},error:()=>{}
  });
  const first=check();
  assert.equal(await check(),false);
  assert.equal(reads,1);
  release({rows:[{}]});
  await first;
  assert.equal(reads,1);
});

test("stale detection respects retry due time and an active delivery",()=>{
  assert.match(OUTBOX_HEALTH_SQL,/n\.next_attempt_at\s*<\s*now\(\)\s*-\s*interval '15 minutes'/);
  assert.match(OUTBOX_HEALTH_SQL,/AND next_attempt_at\s*<\s*now\(\)\s*-\s*interval '15 minutes'/);
  assert.match(OUTBOX_HEALTH_SQL,/n\.status = 'delivering'[\s\S]*NOT EXISTS[\s\S]*d\.status IN \('pending','retry','processing'\)/);
  assert.doesNotMatch(OUTBOX_HEALTH_SQL,/FROM notification_deliveries\s+WHERE[\s\S]*AND created_at\s*<\s*now\(\)\s*-\s*interval '15 minutes'/);
});
