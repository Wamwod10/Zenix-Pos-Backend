import "dotenv/config";

const token=String(process.env.ZENIX_PAYMENT_BOT_TOKEN||"").trim();
const publicApiUrl=String(process.env.PUBLIC_API_URL||"").trim().replace(/\/$/,"");
const secret=String(process.env.ZENIX_PAYMENT_WEBHOOK_SECRET||"").trim();

if(!token)throw new Error("ZENIX_PAYMENT_BOT_TOKEN is required");
if(!publicApiUrl)throw new Error("PUBLIC_API_URL is required");
if(!/^https:\/\//i.test(publicApiUrl))throw new Error("PUBLIC_API_URL must use HTTPS for Telegram webhook");
if(secret.length<16)throw new Error("ZENIX_PAYMENT_WEBHOOK_SECRET must be at least 16 characters");

const webhookUrl=`${publicApiUrl}/api/telegram/payment/webhook`;
const response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{
  method:"POST",
  headers:{"content-type":"application/json"},
  body:JSON.stringify({url:webhookUrl,secret_token:secret,allowed_updates:["callback_query"],drop_pending_updates:false}),
  signal:AbortSignal.timeout(15000),
});
const payload=await response.json().catch(()=>({}));
if(!response.ok||!payload.ok)throw new Error(`Payment Telegram setWebhook failed (${response.status}): ${String(payload.description||"unknown error").slice(0,300)}`);
console.log(`[payment-telegram] webhook configured: ${webhookUrl}`);
