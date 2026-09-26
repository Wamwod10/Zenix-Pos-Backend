import test from "node:test";
import assert from "node:assert/strict";

process.env.ZENIX_PAYMENT_WEBHOOK_SECRET = "webhook-secret";
process.env.ZENIX_PAYMENT_ADMIN_CHAT_ID = "-1001";
process.env.ZENIX_PAYMENT_ADMIN_USER_IDS = "123,456";

const webhook = await import("../src/routes/paymentTelegram.js");
const { derivePaymentReviewToken, hashPaymentReviewToken } = await import("../src/services/paymentTelegram.js");

const token = derivePaymentReviewToken("payment-1", "webhook-secret");
const update = (overrides = {}) => ({ callback_query: {
  id: "callback-1", from: { id: 123, username: "platform_owner" },
  data: `pa:${token}`, message: { message_id: 77, chat: { id: -1001 }, caption: "payment" },
  ...overrides,
} });

test("callback authorization requires both configured chat and whitelisted user", () => {
  assert.equal(webhook.isAuthorizedPaymentAdmin({ chatId: "-1001", userId: "123", adminChatId: "-1001", adminUserIds: ["123"] }), true);
  assert.equal(webhook.isAuthorizedPaymentAdmin({ chatId: "-2002", userId: "123", adminChatId: "-1001", adminUserIds: ["123"] }), false);
  assert.equal(webhook.isAuthorizedPaymentAdmin({ chatId: "-1001", userId: "999", adminChatId: "-1001", adminUserIds: ["123"] }), false);
});

test("unauthorized callback never reads or mutates payment data", async () => {
  let dbCalls = 0;
  const answers = [];
  const outcome = await webhook.handlePaymentCallback(update({ from: { id: 999 } }), {
    db: { query: async () => { dbCalls += 1; return { rows: [] }; } },
    reviewPayment: async () => { throw new Error("must not review"); },
    answerCallback: async (...args) => answers.push(args), editMessage: async () => {},
    config: { paymentAdminChatId: "-1001", paymentAdminUserIds: ["123"] },
  });
  assert.equal(outcome, "unauthorized");
  assert.equal(dbCalls, 0);
  assert.equal(answers[0][1], "Bu amal uchun ruxsat yo'q.");
});

test("valid approve resolves payment only by token hash and finalizes its Telegram message", async () => {
  const calls = { query: null, review: null, edit: null, answer: null };
  const outcome = await webhook.handlePaymentCallback(update(), {
    db: { query: async (sql, params) => {
      calls.query = { sql, params };
      return { rows: [{ id: "payment-1", status: "REVIEW", order_id: "ZX-1", telegram_review_token_expires_at: "2099-01-01T00:00:00.000Z" }] };
    } },
    reviewPayment: async (input) => { calls.review = input; return { outcome: "approved", payment: { order_id: "ZX-1" } }; },
    answerCallback: async (...args) => { calls.answer = args; },
    editMessage: async (...args) => { calls.edit = args; },
    config: { paymentAdminChatId: "-1001", paymentAdminUserIds: ["123"] },
  });
  assert.equal(outcome, "approved");
  assert.deepEqual(calls.query.params, [hashPaymentReviewToken(token)]);
  assert.equal(calls.review.paymentId, "payment-1");
  assert.equal(calls.review.decision, "APPROVED");
  assert.deepEqual(calls.review.actor, { source: "telegram", telegramUserId: "123", telegramUsername: "platform_owner", telegramChatId: "-1001" });
  assert.equal(calls.edit[0], "-1001");
  assert.equal(calls.edit[1], 77);
  assert.equal(calls.edit[3].hasCaption, true);
});

test("processed payment cannot be approved or rejected again", async () => {
  let reviewed = 0;
  const answers = [];
  const outcome = await webhook.handlePaymentCallback(update({ data: `pr:${token}` }), {
    db: { query: async () => ({ rows: [{ id: "payment-1", status: "APPROVED", telegram_review_token_expires_at: "2099-01-01" }] }) },
    reviewPayment: async () => { reviewed += 1; },
    answerCallback: async (...args) => answers.push(args), editMessage: async () => {},
    config: { paymentAdminChatId: "-1001", paymentAdminUserIds: ["123"] },
  });
  assert.equal(outcome, "alreadyReviewed");
  assert.equal(reviewed, 0);
  assert.equal(answers[0][1], "Bu to'lov allaqachon ko'rib chiqilgan.");
});

test("expired callback token cannot review a payment", async () => {
  let reviewed = 0;
  const outcome = await webhook.handlePaymentCallback(update(), {
    db: { query: async () => ({ rows: [{ id: "payment-1", status: "REVIEW", telegram_review_token_expires_at: "2020-01-01" }] }) },
    reviewPayment: async () => { reviewed += 1; }, answerCallback: async () => {}, editMessage: async () => {},
    config: { paymentAdminChatId: "-1001", paymentAdminUserIds: ["123"] },
  });
  assert.equal(outcome, "expired");
  assert.equal(reviewed, 0);
});

test("valid reject uses the database payment and does not activate it", async () => {
  let reviewInput;
  const outcome = await webhook.handlePaymentCallback(update({ data: `pr:${token}` }), {
    db: { query: async () => ({ rows: [{ id: "payment-1", status: "REVIEW", order_id: "ZX-1", telegram_review_token_expires_at: "2099-01-01" }] }) },
    reviewPayment: async (input) => { reviewInput = input; return { outcome: "rejected", payment: { order_id: "ZX-1" } }; },
    answerCallback: async () => {}, editMessage: async () => {},
    config: { paymentAdminChatId: "-1001", paymentAdminUserIds: ["123"] },
  });
  assert.equal(outcome, "rejected");
  assert.equal(reviewInput.paymentId, "payment-1");
  assert.equal(reviewInput.decision, "REJECTED");
});
