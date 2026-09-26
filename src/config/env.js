import "dotenv/config";

const required = (name, fallback = "") => {
  const value = process.env[name] ?? fallback;
  if (!value && process.env.NODE_ENV === "production") throw new Error(`${name} is required`);
  return value;
};

const isProduction = process.env.NODE_ENV === "production";
const productionValue = (name, developmentFallback = "") => process.env[name] || (isProduction ? "" : developmentFallback);

export const parseTelegramAdminUserIds = (value = "") => {
  const ids = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d+$/.test(id))) throw new Error("ZENIX_PAYMENT_ADMIN_USER_IDS must contain comma-separated Telegram user IDs");
  return [...new Set(ids)];
};

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  databaseUrl: required("DATABASE_URL"),
  databasePoolMax: process.env.DB_POOL_MAX || "5",
  frontendOrigins: String(productionValue("FRONTEND_ORIGIN", "http://localhost:5173")).split(",").map((v) => v.trim()).filter(Boolean),
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "zenix_session",
  sessionTtlDays: Math.max(1, Number(process.env.SESSION_TTL_DAYS || 30)),
  telegramBotToken: productionValue("TELEGRAM_BOT_TOKEN"),
  telegramWebhookSecret: productionValue("TELEGRAM_WEBHOOK_SECRET"),
  telegramBotUsername: (process.env.TELEGRAM_BOT_USERNAME || "zenixposbot").replace(/^@/, ""),
  paymentBotToken: productionValue("ZENIX_PAYMENT_BOT_TOKEN"),
  paymentAdminChatId: productionValue("ZENIX_PAYMENT_ADMIN_CHAT_ID"),
  paymentAdminUserIds: parseTelegramAdminUserIds(process.env.ZENIX_PAYMENT_ADMIN_USER_IDS),
  paymentWebhookSecret: productionValue("ZENIX_PAYMENT_WEBHOOK_SECRET"),
  paymentBotUsername: (process.env.ZENIX_PAYMENT_BOT_USERNAME || "zenixpaymentbot").replace(/^@/, ""),
  publicApiUrl: productionValue("PUBLIC_API_URL", "http://localhost:4000"),
  isProduction,
});

export const assertServerEnvironment = (config = env) => {
  if (!config.isProduction) return;
  const missing = [
    ["FRONTEND_ORIGIN", config.frontendOrigins?.length],
    ["TELEGRAM_BOT_TOKEN", config.telegramBotToken],
    ["TELEGRAM_WEBHOOK_SECRET", config.telegramWebhookSecret],
    ["PUBLIC_API_URL", config.publicApiUrl],
    ["ZENIX_PAYMENT_BOT_TOKEN", config.paymentBotToken],
    ["ZENIX_PAYMENT_ADMIN_CHAT_ID", /^-\d+$/.test(String(config.paymentAdminChatId || ""))],
    ["ZENIX_PAYMENT_ADMIN_USER_IDS", config.paymentAdminUserIds?.length],
    ["ZENIX_PAYMENT_WEBHOOK_SECRET", String(config.paymentWebhookSecret || "").length >= 16],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) throw new Error(`${missing.join(", ")} are required in production`);
};
