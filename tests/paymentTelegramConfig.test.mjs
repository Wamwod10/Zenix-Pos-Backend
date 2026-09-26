import test from "node:test";
import assert from "node:assert/strict";

process.env.ZENIX_PAYMENT_WEBHOOK_SECRET = "payment-webhook-test-secret";
process.env.ZENIX_PAYMENT_ADMIN_CHAT_ID = "-1001234567890";
process.env.ZENIX_PAYMENT_ADMIN_USER_IDS = "123456789, 987654321";

const envModule = await import("../src/config/env.js");
const { app } = await import("../src/app.js");

test("payment admin whitelist accepts only comma-separated Telegram integer IDs", () => {
  assert.deepEqual(envModule.parseTelegramAdminUserIds("123456789, 987654321,123456789"), ["123456789", "987654321"]);
  assert.throws(() => envModule.parseTelegramAdminUserIds("123,owner,456"), /ZENIX_PAYMENT_ADMIN_USER_IDS/);
});

test("production startup requires isolated payment bot configuration", () => {
  assert.throws(() => envModule.assertServerEnvironment({
    isProduction: true,
    frontendOrigins: ["https://pos.example"],
    telegramBotToken: "pos-token",
    telegramWebhookSecret: "pos-secret",
    publicApiUrl: "https://api.example",
    paymentBotToken: "",
    paymentAdminChatId: "",
    paymentAdminUserIds: [],
    paymentWebhookSecret: "",
  }), /ZENIX_PAYMENT_BOT_TOKEN.*ZENIX_PAYMENT_ADMIN_CHAT_ID.*ZENIX_PAYMENT_ADMIN_USER_IDS.*ZENIX_PAYMENT_WEBHOOK_SECRET/);
});

test("production rejects a weak payment webhook secret or non-group chat ID", () => {
  const base = {
    isProduction: true, frontendOrigins: ["https://pos.example"], telegramBotToken: "pos-token",
    telegramWebhookSecret: "pos-secret", publicApiUrl: "https://api.example", paymentBotToken: "payment-token",
    paymentAdminUserIds: ["123456789"], paymentWebhookSecret: "1234567890123456", paymentAdminChatId: "-1001234567890",
  };
  assert.throws(() => envModule.assertServerEnvironment({ ...base, paymentWebhookSecret: "short" }), /ZENIX_PAYMENT_WEBHOOK_SECRET/);
  assert.throws(() => envModule.assertServerEnvironment({ ...base, paymentAdminChatId: "123456789" }), /ZENIX_PAYMENT_ADMIN_CHAT_ID/);
  assert.doesNotThrow(() => envModule.assertServerEnvironment(base));
});

test("payment webhook is public at the client guard but rejects a bad Telegram secret", async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/telegram/payment/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: "{}",
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.notEqual(body?.error?.code, "UNTRUSTED_CLIENT");
});
