import { env } from "../config/env.js";
import { HttpError } from "../lib/http.js";

const SAFE_METHODS=new Set(["GET","HEAD","OPTIONS"]);
const TELEGRAM_WEBHOOK_PATH="/api/telegram/webhook";
const PAYMENT_TELEGRAM_WEBHOOK_PATH="/api/telegram/payment/webhook";

export function requireTrustedClient(req,_res,next){
  const requestPath=String(req.originalUrl||req.url||req.path||"").split("?")[0];
  if(SAFE_METHODS.has(req.method)||requestPath===TELEGRAM_WEBHOOK_PATH||requestPath===PAYMENT_TELEGRAM_WEBHOOK_PATH)return next();

  const marker=String(req.get("x-zenix-client")||"").trim().toLowerCase();
  if(marker!=="web")return next(new HttpError(403,"So‘rov manbasi tasdiqlanmadi","UNTRUSTED_CLIENT"));

  const origin=String(req.get("origin")||"").trim();
  if(origin&& !env.frontendOrigins.includes(origin))return next(new HttpError(403,"So‘rov manbasi ruxsat etilmagan","UNTRUSTED_ORIGIN"));
  next();
}
