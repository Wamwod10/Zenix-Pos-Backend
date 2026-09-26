import "dotenv/config";

const required = (name, fallback = "") => {
  const value = process.env[name] ?? fallback;
  if (!value && process.env.NODE_ENV === "production") throw new Error(`${name} is required`);
  return value;
};

const isProduction = process.env.NODE_ENV === "production";
const productionValue = (name, developmentFallback = "") => process.env[name] || (isProduction ? "" : developmentFallback);

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
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) throw new Error(`${missing.join(", ")} are required in production`);
};
