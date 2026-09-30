import { env } from "../config/env.js";
import { telegramRequest } from "./telegram.js";

export function normalizeTelegramWebhookSecret(value){
  const secret=String(value||"").trim();
  if(!/^[A-Za-z0-9_-]{16,256}$/.test(secret))throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 characters using only A-Z, a-z, 0-9, _ and -");
  return secret;
}

function normalizePublicApiUrl(value){
  let parsed;
  try{parsed=new URL(String(value||"").trim());}catch{throw new Error("PUBLIC_API_URL must be a valid HTTPS origin");}
  if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.search||parsed.hash||!["","/"].includes(parsed.pathname)){
    throw new Error("PUBLIC_API_URL must be a clean HTTPS origin without credentials, path, query or fragment");
  }
  return parsed.origin;
}

export async function configureTelegramWebhook({ config=env, request=telegramRequest }={}){
  const token=String(config.telegramBotToken||"").trim();
  const publicApiUrl=normalizePublicApiUrl(config.publicApiUrl);
  const secret=normalizeTelegramWebhookSecret(config.telegramWebhookSecret);

  if(!token)throw new Error("TELEGRAM_BOT_TOKEN is required");

  const url=`${publicApiUrl}/api/telegram/webhook`;
  await request("setWebhook",{
    url,
    secret_token:secret,
    allowed_updates:["message","my_chat_member"],
    drop_pending_updates:false,
  });
  return {configured:true,url};
}

export async function assertTelegramWebhookReady({configure=configureTelegramWebhook}={}){
  try{return await configure()}
  catch(cause){
    const error=new Error("Telegram ulash xizmati hozir tayyor emas",{cause});
    error.code="TELEGRAM_WEBHOOK_UNAVAILABLE";
    throw error;
  }
}


export async function configurePaymentTelegramWebhook({config=env,fetchImpl=fetch}={}){
  const token=String(config.paymentBotToken||"").trim();
  const publicApiUrl=normalizePublicApiUrl(config.publicApiUrl);
  const secret=normalizeTelegramWebhookSecret(config.paymentWebhookSecret);
  if(!token)throw new Error("ZENIX_PAYMENT_BOT_TOKEN is required");
  const url=`${publicApiUrl}/api/telegram/payment/webhook`;
  const response=await fetchImpl(`https://api.telegram.org/bot${token}/setWebhook`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url,secret_token:secret,allowed_updates:["callback_query"],drop_pending_updates:false}),signal:AbortSignal.timeout(15000)});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||!payload.ok)throw new Error(`Payment Telegram setWebhook failed (${response.status}): ${String(payload.description||"unknown error").slice(0,300)}`);
  return {configured:true,url};
}
