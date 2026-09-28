import "dotenv/config";
import { configureTelegramWebhook } from "../src/services/telegramWebhook.js";

const {url}=await configureTelegramWebhook();
console.log(`[telegram] webhook configured: ${url}`);
