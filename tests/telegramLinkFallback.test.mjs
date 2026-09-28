import test from "node:test";
import assert from "node:assert/strict";

test("accepts a one-time connect command when Telegram drops the startgroup payload",async()=>{
  const telegramRoute=await import("../src/routes/telegram.js");

  assert.equal(typeof telegramRoute.parseTelegramLinkCommand,"function","Telegram route must expose its command parser");
  assert.deepEqual(
    telegramRoute.parseTelegramLinkCommand("/connect@zenixposbot AbC_123-xYz"),
    {command:"connect",token:"AbC_123-xYz"},
  );
  assert.deepEqual(
    telegramRoute.parseTelegramLinkCommand("/start@zenixposbot AbC_123-xYz"),
    {command:"start",token:"AbC_123-xYz"},
  );
  assert.deepEqual(
    telegramRoute.parseTelegramLinkCommand("/connect@zenixposbot"),
    {command:"connect",token:""},
  );
  assert.equal(telegramRoute.parseTelegramLinkCommand("/connect@zenixposbot invalid token"),null);
});

test("returns a copyable one-time group command with each Telegram link",async()=>{
  const telegramRoute=await import("../src/routes/telegram.js");

  assert.equal(typeof telegramRoute.telegramLinkPayload,"function","Telegram route must expose its link payload builder");
  assert.deepEqual(
    telegramRoute.telegramLinkPayload({raw:"AbC_123-xYz",botUsername:"@zenixposbot"}),
    {
      deepLink:"https://t.me/zenixposbot?startgroup=AbC_123-xYz",
      fallbackCommand:"/connect@zenixposbot AbC_123-xYz",
      botUsername:"@zenixposbot",
      expiresInSeconds:900,
    },
  );
});
