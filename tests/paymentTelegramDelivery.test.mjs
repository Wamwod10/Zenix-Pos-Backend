import test from "node:test";
import assert from "node:assert/strict";

const telegram = await import("../src/services/paymentTelegram.js");
const worker = await import("../src/services/paymentNotificationWorker.js");

const payment = {
  id: "c9c8d2c6-51ca-46e6-b20a-1dc36688e95c", order_id: "ZX-ABC123", organization_name: "Zenix Market",
  owner_name: "Ali Valiyev", owner_phone: "+998901234567", type: "LICENSE", plan: "ANNUAL",
  amount: 3300000, extension_days: 365, extra_store_count: 0, submitted_at: "2026-09-26T12:10:00.000Z",
  receipt_name: "chek.pdf", receipt_type: "application/pdf", receipt_content: Buffer.from("safe-pdf"),
};

test('payment layout separates fields and bounds long display values without changing source',()=>{
  const source={...payment,organization_name:'A'.repeat(200),owner_name:'B'.repeat(200),status:'REJECTED',reject_reason:'Sabab '.repeat(100)};
  const text=telegram.formatPaymentReviewMessage(source,{telegramUsername:'admin'});
  assert.match(text,/<\/b>\n\n👤 Egasi:/);
  assert.ok(!text.includes('A'.repeat(65)));
  assert.ok(!text.includes('B'.repeat(49)));
  assert.ok(text.split('📝 Sabab: ')[1].length<=160);
  assert.equal(source.organization_name.length,200);
});

test("payment review text contains trusted billing details in Uzbek", () => {
  const text = telegram.formatPaymentReviewMessage(payment);
  for (const expected of ["ZENIX POS BOT", "Obuna to‘lovi", "Zenix Market", "Ali Valiyev", "+998901234567", "Yillik", "12 oy", "2 ta", "3 300 000", "ZX-ABC123", "Tekshiruvda"]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test('final review preserves every trusted detail, reviewer, time and reason', () => {
  for (const status of ['APPROVED','REJECTED']) {
    const text=telegram.formatPaymentReviewMessage({...payment,status,reviewed_at:'2026-10-15T07:02:00Z',reject_reason:'<wrong & receipt>'}, {telegramUsername:'admin'});
    for(const value of ['Zenix Market','Ali Valiyev','+998901234567','ZX-ABC123','3 300 000','@admin','15.10.2026, 12:02']) assert.ok(text.includes(value),value);
    assert.ok(text.includes(status==='APPROVED'?'TO‘LOV TASDIQLANDI':'TO‘LOV RAD ETILDI'));
    if(status==='REJECTED')assert.ok(text.includes('&lt;wrong &amp; receipt&gt;'));
  }
  assert.doesNotThrow(()=>telegram.formatPaymentReviewMessage({submitted_at:'bad'}));
});

test("callback token is opaque, deterministic for retry, and contains no tenant data", () => {
  const one = telegram.derivePaymentReviewToken(payment.id, "strong-webhook-secret");
  const two = telegram.derivePaymentReviewToken(payment.id, "strong-webhook-secret");
  assert.equal(one, two);
  assert.match(one, /^[A-Za-z0-9_-]{24}$/);
  assert.doesNotMatch(one, /c9c8d2c6|ZX-|3300000|ANNUAL/);
  assert.equal(telegram.hashPaymentReviewToken(one).length, 64);
  assert.ok(`pa:${one}`.length <= 64);
});

test("receipt is uploaded from database bytes with the isolated payment token", async () => {
  const requests = [];
  const client = telegram.createPaymentTelegramClient({
    token: "payment-token-only",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 77, chat: { id: -1001 } } }) };
    },
  });
  const result = await client.sendPaymentReview(payment, "opaque_token_1234567890ab", "-1001");
  assert.equal(result.message_id, 77);
  assert.match(requests[0].url, /botpayment-token-only\/sendDocument$/);
  assert.ok(requests[0].options.body instanceof FormData);
  assert.equal(requests[0].options.body.get("chat_id"), "-1001");
  assert.equal(requests[0].options.body.get("document").size, payment.receipt_content.length);
  const keyboard = JSON.parse(requests[0].options.body.get("reply_markup"));
  assert.deepEqual(keyboard.inline_keyboard[0].map((button) => button.callback_data), ["pa:opaque_token_1234567890ab", "pr:opaque_token_1234567890ab"]);
});

test("payment worker leaves a failed Telegram event retryable", async () => {
  const result = worker.paymentRetryState(0, new Error("temporary Telegram failure"));
  assert.equal(result.status, "retry");
  assert.equal(result.attempts, 1);
  assert.match(result.lastError, /temporary Telegram failure/);
  assert.ok(result.delaySeconds >= 30);
});
