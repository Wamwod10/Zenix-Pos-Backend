import test from "node:test";
import assert from "node:assert/strict";
import {createWorkerMaintenanceGate, isFinancialWriteMaintenance} from "../src/services/workerMaintenanceGate.js";

test("maintenance pauses only worker polling for 60 seconds without replaying tasks", async () => {
  let time = 1_000;
  let requests = 0;
  const warns = [];
  const gate = createWorkerMaintenanceGate({name:"fixture", now:()=>time, warn:x=>warns.push(x), error:()=>assert.fail("unexpected error")});
  const work = async () => {
    requests++;
    if (requests===1) throw new Error("financial writes paused during migration");
  };
  assert.equal(isFinancialWriteMaintenance(new Error("financial writes paused")),true);
  assert.equal(await gate(work),false);
  for(let i=0;i<5;i++){time+=10_000;assert.equal(await gate(work),false);}
  assert.equal(requests,1,"no extra event scans during maintenance");
  assert.equal(warns.length,1,"no alert storm");
  time+=10_000;
  assert.equal(await gate(work),true);
  assert.equal(requests,2,"one fresh read after bounded pause");
  assert.match(warns[1],/resumed/);
});

test("unexpected worker failures remain visible and are not artificially delayed", async () => {
  const failures=[];
  const gate=createWorkerMaintenanceGate({name:"fixture",error:(...args)=>failures.push(args),warn:()=>assert.fail("not maintenance")});
  let calls=0;
  const task=async()=>{calls++;if(calls===1)throw new Error("real connection failure")};
  assert.equal(await gate(task),false);
  assert.equal(await gate(task),true);
  assert.equal(calls,2);
  assert.equal(failures.length,1);
});

test("concurrent timer ticks never run a second in-flight task", async () => {
  let release,requests=0;
  const gate=createWorkerMaintenanceGate({name:"fixture"});
  const first=gate(()=>{requests++;return new Promise(resolve=>{release=resolve})});
  assert.equal(await gate(()=>{requests++;}),false);
  assert.equal(requests,1);
  release();
  assert.equal(await first,true);
  assert.equal(await gate(()=>{requests++;}),true);
  assert.equal(requests,2);
});
