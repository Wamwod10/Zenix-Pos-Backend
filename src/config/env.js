import { isIP } from "node:net";
import { trialVerificationPolicy } from "../services/trialVerificationPolicy.js";

try {
  await import("dotenv/config");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const parseBoundedInteger = (source, name, fallback, minimum, maximum) => {
  const raw = source[name] ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
};

const parseHttpUrl = (value, name, { httpsOnly = false, exactOrigin = false } = {}) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be a valid HTTP URL without credentials`);
  }
  if (httpsOnly && parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  if (exactOrigin && (parsed.pathname !== "/" || parsed.search || parsed.hash)) {
    throw new Error(`${name} entries must contain origins only, without paths, queries, or fragments`);
  }
  return exactOrigin ? parsed.origin : parsed.href.replace(/\/$/, "");
};

export const parseTelegramAdminUserIds = (value = "") => {
  const ids = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d+$/.test(id))) throw new Error("ZENIX_PAYMENT_ADMIN_USER_IDS must contain comma-separated Telegram user IDs");
  return [...new Set(ids)];
};

export const parseRuntimeEnvironment = (source = process.env) => {
  const nodeEnv = source.NODE_ENV || "development";
  trialVerificationPolicy(source);
  const proxyValue = String(source.TRUST_PROXY || "").trim();
  const trustedProxies = proxyValue ? proxyValue.split(",").map((entry) => {
    const value = entry.trim();
    const [address, prefix, ...extra] = value.split("/");
    const version = isIP(address);
    if (!version || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error("TRUST_PROXY must contain explicit IP addresses or bounded CIDR ranges");
    }
    return value;
  }) : (nodeEnv === "test" ? ["loopback"] : false);
  const isProduction = nodeEnv === "production";
  const productionValue = (name, developmentFallback = "") => source[name] || (isProduction ? "" : developmentFallback);
  const required = (name, fallback = "") => {
    const value = source[name] ?? fallback;
    if (!value && isProduction) throw new Error(`${name} is required`);
    return value;
  };

  const frontendOriginValue = productionValue("FRONTEND_ORIGIN", "http://localhost:5173");
  const frontendOrigins = String(frontendOriginValue).split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((origin) => parseHttpUrl(origin, "FRONTEND_ORIGIN", { httpsOnly: isProduction, exactOrigin: true }));
  const publicApiValue = productionValue("PUBLIC_API_URL", "http://localhost:4000");

  return Object.freeze({
    nodeEnv,
    trustedProxies,
    port: parseBoundedInteger(source, "PORT", 4000, 1, 65535),
    databaseUrl: required("DATABASE_URL"),
    migrationDatabaseUrl: source.MIGRATION_DATABASE_URL || (isProduction ? "" : required("DATABASE_URL")),
    databasePoolMax: source.DB_POOL_MAX || "5",
    databaseConnectionTimeoutMs: parseBoundedInteger(source, "DB_CONNECTION_TIMEOUT_MS", 10_000, 1_000, 60_000),
    databaseIdleTimeoutMs: parseBoundedInteger(source, "DB_IDLE_TIMEOUT_MS", 30_000, 1_000, 300_000),
    databaseStatementTimeoutMs: parseBoundedInteger(source, "DB_STATEMENT_TIMEOUT_MS", 30_000, 1_000, 120_000),
    databaseQueryTimeoutMs: parseBoundedInteger(source, "DB_QUERY_TIMEOUT_MS", 35_000, 1_000, 180_000),
    databaseIdleTransactionTimeoutMs: parseBoundedInteger(source, "DB_IDLE_TX_TIMEOUT_MS", 15_000, 1_000, 120_000),
    frontendOrigins,
    sessionCookieName: source.SESSION_COOKIE_NAME || "zenix_session",
    sessionTtlDays: parseBoundedInteger(source, "SESSION_TTL_DAYS", 30, 1, 365),
    smsProvider: source.SMS_PROVIDER || "",
    otpHmacSecret: source.OTP_HMAC_SECRET || "",
    telegramBotToken: productionValue("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecret: productionValue("TELEGRAM_WEBHOOK_SECRET"),
    telegramBotUsername: (source.TELEGRAM_BOT_USERNAME || "zenixposbot").replace(/^@/, ""),
    paymentBotToken: productionValue("ZENIX_PAYMENT_BOT_TOKEN"),
    paymentAdminChatId: productionValue("ZENIX_PAYMENT_ADMIN_CHAT_ID"),
    paymentAdminUserIds: parseTelegramAdminUserIds(source.ZENIX_PAYMENT_ADMIN_USER_IDS),
    paymentWebhookSecret: productionValue("ZENIX_PAYMENT_WEBHOOK_SECRET"),
    paymentBotUsername: (source.ZENIX_PAYMENT_BOT_USERNAME || "zenixpaymentbot").replace(/^@/, ""),
    publicApiUrl: publicApiValue ? parseHttpUrl(publicApiValue, "PUBLIC_API_URL", { httpsOnly: isProduction }) : "",
    isProduction,
  });
};

export const env = parseRuntimeEnvironment();

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
