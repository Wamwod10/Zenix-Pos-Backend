import "dotenv/config";

const token=String(process.env.TELEGRAM_BOT_TOKEN||"").trim();
const publicApiUrl=String(process.env.PUBLIC_API_URL||"").trim().replace(/\/$/,"");
const secret=String(process.env.TELEGRAM_WEBHOOK_SECRET||"").trim();

if(!token)throw new Error("TELEGRAM_BOT_TOKEN is required");
if(!publicApiUrl)throw new Error("PUBLIC_API_URL is required");
if(!/^https:\/\//i.test(publicApiUrl))throw new Error("PUBLIC_API_URL must use HTTPS for Telegram webhook");
if(secret&&secret.length<16)throw new Error("TELEGRAM_WEBHOOK_SECRET should be at least 16 characters");

const webhookUrl=`${publicApiUrl}/api/telegram/webhook`;
const response=await fetch(`https://api.telegram.org/bot${token}/setWebhook`,{
  method:"POST",
  headers:{"content-type":"application/json"},
  body:JSON.stringify({
    url:webhookUrl,
    ...(secret?{secret_token:secret}:{}),
    allowed_updates:["message","my_chat_member"],
    drop_pending_updates:false,
  }),
});
const payload=await response.json().catch(()=>({}));
if(!response.ok||!payload.ok)throw new Error(payload.description||`Telegram setWebhook failed (${response.status})`);
console.log(`[telegram] webhook configured: ${webhookUrl}`);
