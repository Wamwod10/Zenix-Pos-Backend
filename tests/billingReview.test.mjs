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
      if (/SELECT organization_id FROM billing_payments/.test(sql)) {
        return { rows: overrides.missingPayment ? [] : [{ organization_id: state.payment.organization_id }] };
      }
      if (/SELECT id FROM organizations WHERE id=\$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: state.payment.organization_id }] };
      }
      if (/SELECT bp\.\*,o\./.test(sql)) return { rows: [state.payment] };
      if (/SELECT \* FROM billing_payments/.test(sql)) return {rows:[state.payment]};
      if (/SELECT \* FROM platform_promo_reservations/.test(sql)) return {rows:[]};
      if (/SELECT metadata FROM billing_drafts/.test(sql)) return {rows:[]};
      if (/SELECT id FROM billing_payments/.test(sql)) return {rowCount: overrides.otherPending ? 1 : 0, rows:[]};
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
    assert.match(client.state.queries[0].sql, /SELECT organization_id FROM billing_payments/);
    assert.match(client.state.queries[1].sql, /SELECT id FROM organizations WHERE id=\$1 FOR UPDATE/);
    assert.match(client.state.queries[2].sql, /FOR UPDATE OF bp/);
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

test('missing payment is rejected before obtaining any organization lock', async () => {
  const client = createClient({ missingPayment: true });
  await assert.rejects(applyBillingReview(client, { paymentId: 'missing', decision: 'APPROVED' }),
    error => error.status === 404 && error.code === 'PAYMENT_NOT_FOUND');
  assert.equal(client.state.queries.length, 1);
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


test('approval fails closed when another pending payment can change the same branch limit',async()=>{
  const client=createClient({otherPending:true});
  await assert.rejects(applyBillingReview(client,{paymentId:'payment-1',decision:'APPROVED'}),
    error=>error.status===409&&error.code==='BILLING_REVIEW_CONFLICT');
  assert.equal(client.state.organizationUpdate,null);
  assert.equal(client.state.audit,null);
});

test('conflicting historical pending payments may still be rejected to resolve the conflict',async()=>{
  const client=createClient({otherPending:true});
  const result=await applyBillingReview(client,{paymentId:'payment-1',decision:'REJECTED'});
  assert.equal(result.outcome,'rejected');
});
