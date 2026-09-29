import test from "node:test";
import assert from "node:assert/strict";

const seed = await import("../src/services/zenixMarketSeed.js").catch(() => ({}));

test("target profile validation anchors the seed to the login's existing tenant", () => {
  assert.equal(typeof seed.validateTargetProfile, "function");
  const target = seed.validateTargetProfile([{
    id: "user-1", organization_id: "org-profile", store_id: "store-1",
    username: "umidjon", active: true, organization_name: "Zenix market",
  }], "umidjon", "Zenix Market");
  assert.deepEqual(target, {
    userId: "user-1", organizationId: "org-profile", storeId: "store-1",
    username: "umidjon", organizationName: "Zenix market",
  });
  assert.throws(() => seed.validateTargetProfile([], "umidjon", "Zenix Market"), /exactly one/i);
  assert.throws(() => seed.validateTargetProfile([{ id:"u", organization_id:"other", store_id:"s", username:"umidjon", active:true, organization_name:"Other" }], "umidjon", "Zenix Market"), /organization/i);
});

test("catalog contains 100 realistic uniquely identified profitable products", () => {
  assert.equal(typeof seed.buildCatalog, "function");
  const products = seed.buildCatalog();
  assert.equal(products.length, 100);
  assert.equal(new Set(products.map((p) => p.category)).size, 10);
  assert.equal(new Set(products.map((p) => p.sku)).size, 100);
  assert.equal(new Set(products.map((p) => p.barcode)).size, 100);
  assert.ok(products.every((p) => p.name && p.brand && p.unit && p.costPrice > 0 && p.sellPrice > p.costPrice));
  assert.ok(products.every((p) => /^478\d{10}$/.test(p.barcode)));
});

test("seven-day plan is deterministic and its sales, payments, profit and stock reconcile", () => {
  assert.equal(typeof seed.buildDemoPlan, "function");
  const first = seed.buildDemoPlan("2026-09-29");
  const second = seed.buildDemoPlan("2026-09-29");
  assert.deepEqual(first, second);
  assert.equal(first.days.length, 7);
  assert.equal(first.sales.length, 126);
  assert.deepEqual(first.days.map((d) => d.date), [
    "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29",
  ]);
  assert.deepEqual(new Set(first.sales.map((s) => s.paymentKind)), new Set(["cash", "card", "split", "transfer"]));
  assert.deepEqual(first.sales.map((s) => s.createdAt), [...first.sales].map((s) => s.createdAt).sort());

  for (const sale of first.sales) {
    assert.equal(sale.total, sale.items.reduce((sum, item) => sum + item.lineTotal, 0));
    assert.equal(sale.total, sale.payments.reduce((sum, payment) => sum + payment.amount, 0));
    assert.ok(sale.items.every((item) => item.costPrice > 0 && item.unitPrice > item.costPrice));
  }
  assert.equal(first.summary.revenue, first.sales.reduce((sum, sale) => sum + sale.total, 0));
  assert.equal(first.summary.paymentTotal, first.summary.revenue);
  assert.ok(first.summary.grossProfit > 0);
  assert.ok(first.finalStock.every((row) => row.quantity === row.received - row.sold && row.quantity >= 0));
});

test("seed identifiers are stable UUIDs and separated by tenant", () => {
  assert.equal(typeof seed.stableUuid, "function");
  const one = seed.stableUuid("org-a", "product:001");
  assert.match(one, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(one, seed.stableUuid("org-a", "product:001"));
  assert.notEqual(one, seed.stableUuid("org-b", "product:001"));
});

test("seed command defaults to rollback and requires an explicit apply flag", () => {
  assert.equal(typeof seed.parseSeedMode, "function");
  assert.deepEqual(seed.parseSeedMode([]), { apply:false });
  assert.deepEqual(seed.parseSeedMode(["--dry-run"]), { apply:false });
  assert.deepEqual(seed.parseSeedMode(["--apply"]), { apply:true });
  assert.throws(() => seed.parseSeedMode(["--apply","--dry-run"]), /choose exactly one/i);
  assert.throws(() => seed.parseSeedMode(["--force"]), /unknown argument/i);
});

test("reruns retain the original anchor date instead of creating a moving window", () => {
  assert.equal(typeof seed.resolveAnchorDate, "function");
  assert.equal(seed.resolveAnchorDate(null, "2026-10-01"), "2026-10-01");
  assert.equal(seed.resolveAnchorDate("2026-09-30", "2026-10-01"), "2026-09-30");
  assert.throws(() => seed.resolveAnchorDate("30-09-2026", "2026-10-01"), /anchor/i);
});

test("operational safety gate fails closed for any live tenant activity", () => {
  assert.equal(typeof seed.assertOperationalSafety, "function");
  assert.doesNotThrow(() => seed.assertOperationalSafety({non_seed_movements:0,non_seed_window_sales:0,returns:0,foreign_open_shifts:0,foreign_business_days:0,ledger_mismatches:0}));
  for (const field of ["non_seed_movements","non_seed_window_sales","returns","foreign_open_shifts","foreign_business_days","ledger_mismatches"]) {
    assert.throws(() => seed.assertOperationalSafety({[field]:1}), /operational data changed/i);
  }
});
