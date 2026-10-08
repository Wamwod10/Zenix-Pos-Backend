import test from "node:test";
import assert from "node:assert/strict";

import { createShutdownController } from "../src/shutdown.js";

test("graceful shutdown stops workers, closes HTTP, then ends the pool", async () => {
  const calls = [];
  const exits = [];
  const controller = createShutdownController({
    server: {
      close(callback) { calls.push("server.close"); callback(); },
      closeIdleConnections() { calls.push("server.closeIdleConnections"); },
    },
    pool: { async end() { calls.push("pool.end"); } },
    stoppers: [async () => { calls.push("worker.stop"); }],
    exit: (code) => exits.push(code),
    setTimer: () => ({ unref() {}, close() { calls.push("timer.close"); } }),
    logger: { info() {}, error() {} },
  });

  await controller.shutdown("SIGTERM");
  assert.deepEqual(calls.slice(0, 4), ["server.closeIdleConnections", "server.close", "worker.stop", "pool.end"]);
  assert.deepEqual(exits, [0]);
});

test("HTTP stops accepting connections while a worker is still draining", async () => {
  const calls=[];
  let finishWorker;
  const workerDrain=new Promise((resolve)=>{finishWorker=resolve});
  const controller=createShutdownController({
    server:{close(callback){calls.push("server.close");callback()}},
    pool:{async end(){calls.push("pool.end")}},
    stoppers:[async()=>{calls.push("worker.stop");await workerDrain}],
    exit:()=>{},
    setTimer:()=>({unref(){},close(){}}),
    logger:{info(){},error(){}},
  });
  const pending=controller.shutdown("SIGTERM");
  assert.deepEqual(calls,["server.close","worker.stop"]);
  finishWorker();
  await pending;
  assert.equal(calls.at(-1),"pool.end");
});

test("shutdown is idempotent when signals arrive more than once", async () => {
  let poolEnds = 0;
  let exits = 0;
  const controller = createShutdownController({
    pool: { async end() { poolEnds += 1; } },
    exit: () => { exits += 1; },
    setTimer: () => ({ unref() {}, close() {} }),
    logger: { info() {}, error() {} },
  });

  const first = controller.shutdown("SIGTERM");
  const second = controller.shutdown("SIGINT");
  assert.equal(first, second);
  await first;
  assert.equal(poolEnds, 1);
  assert.equal(exits, 1);
});

test("shutdown timeout exits with failure", () => {
  const exits = [];
  let timeoutCallback;
  createShutdownController({
    pool: { async end() {} },
    exit: (code) => exits.push(code),
    setTimer: (callback) => {
      timeoutCallback = callback;
      return { unref() {}, close() {} };
    },
    logger: { info() {}, error() {} },
  }).shutdown("SIGTERM");

  timeoutCallback();
  assert.deepEqual(exits, [1]);
});

test("worker starters return stoppable handles", async () => {
  const notification = await import("../src/services/notificationWorker.js");
  const payment = await import("../src/services/paymentNotificationWorker.js");
  assert.match(notification.startNotificationWorker.toString(), /stop/);
  assert.match(payment.startPaymentNotificationWorker.toString(), /stop/);
});
