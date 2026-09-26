import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { enqueuePaymentReviewNotification } = await import("../src/services/paymentNotifications.js");

test("pending payment creates one tenant-scoped durable review event", async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await enqueuePaymentReviewNotification(client, { id: "payment-1", organization_id: "org-1" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO notification_outbox/);
  assert.match(calls[0].sql, /ON CONFLICT \(organization_id,event_type,event_id\) DO NOTHING/);
  assert.deepEqual(calls[0].params, ["org-1", null, "billing.payment_review", "payment-1", { paymentId: "payment-1" }]);
});

test("customer POS worker excludes platform payment review events", () => {
  const worker = fs.readFileSync(new URL("../src/services/notificationWorker.js", import.meta.url), "utf8");
  assert.match(worker, /event_type\s*<>\s*'billing\.payment_review'/);
});

test("billing submission enqueues review before its transaction returns", () => {
  const billing = fs.readFileSync(new URL("../src/routes/billing.js", import.meta.url), "utf8");
  const insert = billing.indexOf("INSERT INTO billing_payments");
  const enqueue = billing.indexOf("enqueuePaymentReviewNotification", insert);
  const transactionEnd = billing.indexOf("return p;", insert);
  assert.ok(insert >= 0 && enqueue > insert && enqueue < transactionEnd);
});
