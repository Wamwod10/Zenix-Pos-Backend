import test from "node:test";
import assert from "node:assert/strict";

const { applyBillingReview } = await import("../src/services/billingReview.js");

const createClient = (overrides = {}) => {
  const state = {
    payment: {
      id: "payment-1", organization_id: "org-1", organization_name: "Zenix Shop",
      order_id: "ZX-ORDER", status: "REVIEW", type: "LICENSE", plan: "MONTHLY",
      service_period_to: "2026-10-26", extra_store_count: 0,
      expiry_date: null, license_status: "PAYMENT_REQUIRED", store_limit: 2,
      timezone: "Asia/Tashkent", ...overrides,
    },
    queries: [], audit: null, organizationUpdate: null,
  };
  return {
    state,
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (/SELECT bp\.\*,o\./.test(sql)) return { rows: [state.payment] };
      if (/UPDATE billing_payments SET status/.test(sql)) {
        state.payment = { ...state.payment, status: params[1], reject_reason: params[2], reviewed_at: "2026-09-26T12:00:00.000Z" };
        return { rows: [state.payment] };
      }
      if (/UPDATE organizations SET/.test(sql)) { state.organizationUpdate = { sql, params }; return { rows: [] }; }
      if (/INSERT INTO audit_logs/.test(sql)) { state.audit = params; return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
};

for (const [plan, expiry] of [["MONTHLY", "2026-10-26"], ["ANNUAL", "2027-09-26"]]) {
  test(`${plan} approval activates the trusted database period and branch limit`, async () => {
    const client = createClient({ plan, service_period_to: expiry, extra_store_count: 1 });
    const result = await applyBillingReview(client, {
      paymentId: "payment-1", decision: "APPROVED",
      actor: { source: "telegram", telegramUserId: "123456789", telegramUsername: "owner", telegramChatId: "-1001" },
    });
    assert.equal(result.outcome, "approved");
    assert.match(client.state.queries[0].sql, /FOR UPDATE OF bp,o/);
    assert.deepEqual(client.state.organizationUpdate.params, ["org-1", plan, expiry, 3]);
    assert.equal(client.state.audit[3], "approve");
    assert.deepEqual(client.state.audit[10], {
      payment_id: "payment-1", organization_id: "org-1", old_status: "REVIEW", new_status: "APPROVED",
      source: "telegram", telegram_admin_user_id: "123456789", telegram_admin_username: "owner", telegram_chat_id: "-1001",
    });
  });
}

test("a second decision is idempotent and cannot update the organization", async () => {
  const client = createClient({ status: "APPROVED" });
  const result = await applyBillingReview(client, { paymentId: "payment-1", decision: "REJECTED", actor: { source: "telegram" } });
  assert.equal(result.outcome, "alreadyReviewed");
  assert.equal(client.state.organizationUpdate, null);
  assert.equal(client.state.audit, null);
});

test("rejection records review without activating the subscription", async () => {
  const client = createClient({ expiry_date: null });
  const result = await applyBillingReview(client, {
    paymentId: "payment-1", decision: "REJECTED", reason: "Chek tasdiqlanmadi",
    actor: { source: "telegram", telegramUserId: "123", telegramChatId: "-1001" },
  });
  assert.equal(result.outcome, "rejected");
  assert.match(client.state.organizationUpdate.sql, /license_status=\$2/);
  assert.equal(client.state.organizationUpdate.params[1], "REJECTED");
});

test("extra-store approval increases only the locked payment organization limit", async () => {
  const client = createClient({ type: "EXTRA", extra_store_count: 2, organization_id: "org-from-payment" });
  const result = await applyBillingReview(client, {
    paymentId: "payment-1", decision: "APPROVED",
    actor: { source: "telegram", telegramUserId: "123", telegramChatId: "-1001" },
  });
  assert.equal(result.outcome, "approved");
  assert.match(client.state.organizationUpdate.sql, /store_limit=store_limit\+\$2/);
  assert.deepEqual(client.state.organizationUpdate.params, ["org-from-payment", 2]);
});
