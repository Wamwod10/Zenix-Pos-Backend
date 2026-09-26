import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("payment webhook setup is isolated from the POS bot", () => {
  const script = fs.readFileSync(new URL("../scripts/setPaymentTelegramWebhook.js", import.meta.url), "utf8");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["telegram:payment:webhook"], "node scripts/setPaymentTelegramWebhook.js");
  assert.match(script, /ZENIX_PAYMENT_BOT_TOKEN/);
  assert.match(script, /ZENIX_PAYMENT_WEBHOOK_SECRET/);
  assert.match(script, /\/api\/telegram\/payment\/webhook/);
  assert.match(script, /allowed_updates:\["callback_query"\]/);
  assert.doesNotMatch(script, /process\.env\.TELEGRAM_BOT_TOKEN/);
  assert.doesNotMatch(script, /console\.log\([^\n]*(token|secret)/i);
});
