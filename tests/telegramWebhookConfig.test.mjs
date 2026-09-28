import test from "node:test";
import assert from "node:assert/strict";

test("configures the POS Telegram webhook with the public API URL and secret", async()=>{
  const { configureTelegramWebhook } = await import("../src/services/telegramWebhook.js");
  const requests=[];

  const result=await configureTelegramWebhook({
    config:{
      telegramBotToken:"123:test-token",
      telegramWebhookSecret:"a-secure-webhook-secret",
      publicApiUrl:"https://zenix-api.example.com/",
    },
    request:async(method,payload)=>{
      requests.push({method,payload});
      return true;
    },
  });

  assert.deepEqual(result,{
    configured:true,
    url:"https://zenix-api.example.com/api/telegram/webhook",
  });
  assert.deepEqual(requests,[{
    method:"setWebhook",
    payload:{
      url:"https://zenix-api.example.com/api/telegram/webhook",
      secret_token:"a-secure-webhook-secret",
      allowed_updates:["message","my_chat_member"],
      drop_pending_updates:false,
    },
  }]);
});

test("rejects an insecure production webhook URL", async()=>{
  const { configureTelegramWebhook } = await import("../src/services/telegramWebhook.js");

  await assert.rejects(
    configureTelegramWebhook({
      config:{
        telegramBotToken:"123:test-token",
        telegramWebhookSecret:"a-secure-webhook-secret",
        publicApiUrl:"http://zenix-api.example.com",
      },
      request:async()=>true,
    }),
    /HTTPS/,
  );
});

test("normalizes a valid Telegram webhook secret before registration", async()=>{
  const { configureTelegramWebhook, normalizeTelegramWebhookSecret }=await import("../src/services/telegramWebhook.js");
  const requests=[];

  assert.equal(normalizeTelegramWebhookSecret("  valid_SECRET-123456  "),"valid_SECRET-123456");
  await configureTelegramWebhook({
    config:{
      telegramBotToken:"123:test-token",
      telegramWebhookSecret:"  valid_SECRET-123456  ",
      publicApiUrl:"https://zenix-api.example.com/",
    },
    request:async(method,payload)=>requests.push({method,payload}),
  });
  assert.equal(requests[0].payload.secret_token,"valid_SECRET-123456");
});

test("rejects malformed public API URLs and Telegram webhook secrets", async()=>{
  const { configureTelegramWebhook }=await import("../src/services/telegramWebhook.js");
  const base={telegramBotToken:"123:test-token",telegramWebhookSecret:"valid_SECRET-123456"};
  const invalidUrls=[
    "https://user:pass@zenix-api.example.com",
    "https://zenix-api.example.com/base",
    "https://zenix-api.example.com?debug=true",
    "https://zenix-api.example.com#fragment",
  ];
  for(const publicApiUrl of invalidUrls){
    await assert.rejects(configureTelegramWebhook({config:{...base,publicApiUrl},request:async()=>true}),/PUBLIC_API_URL/);
  }
  for(const telegramWebhookSecret of ["bad secret value","x".repeat(257)]){
    await assert.rejects(configureTelegramWebhook({config:{...base,telegramWebhookSecret,publicApiUrl:"https://zenix-api.example.com"},request:async()=>true}),/TELEGRAM_WEBHOOK_SECRET/);
  }
});

test("blocks group linking when the Telegram webhook cannot be configured", async()=>{
  const { assertTelegramWebhookReady }=await import("../src/services/telegramWebhook.js");

  await assert.rejects(
    assertTelegramWebhookReady({configure:async()=>{throw new Error("Telegram API unavailable")}}),
    (error)=>error?.code==="TELEGRAM_WEBHOOK_UNAVAILABLE"&&error?.message==="Telegram ulash xizmati hozir tayyor emas",
  );
});
