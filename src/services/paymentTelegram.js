import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env.js";
import { BILLING_PLANS } from "../config/billing.js";

const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const money = (value) => Math.round(Number(value || 0)).toLocaleString("ru-RU").replaceAll("\u00a0", " ");
const submittedTime = (value) => new Intl.DateTimeFormat("uz-UZ", {
  timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(value));

export const derivePaymentReviewToken = (paymentId, secret) => createHmac("sha256", String(secret)).update(`zenix-payment-review:${paymentId}`).digest("base64url").slice(0, 24);
export const hashPaymentReviewToken = (token) => createHash("sha256").update(String(token)).digest("hex");

export function formatPaymentReviewMessage(payment) {
  const plan = BILLING_PLANS[payment.plan] || BILLING_PLANS.ANNUAL;
  const isExtra = payment.type === "EXTRA";
  const branchLimit = isExtra
    ? Number(payment.store_limit || 0) + Math.max(1, Number(payment.extra_store_count || 1))
    : plan.includedStores + Math.max(0, Number(payment.extra_store_count || 0));
  const lines = [
    "<b>💳 Zenix POS - Yangi to'lov</b>", "",
    `<b>Tashkilot:</b> ${escapeHtml(payment.organization_name)}`,
    `<b>Egasi:</b> ${escapeHtml(payment.owner_name || "Ko'rsatilmagan")}`,
  ];
  if (payment.owner_phone) lines.push(`<b>Telefon:</b> ${escapeHtml(payment.owner_phone)}`);
  lines.push("", `<b>Tarif:</b> ${isExtra ? "Qo'shimcha filial" : escapeHtml(plan.label)}`);
  lines.push(`<b>Davr:</b> ${isExtra ? `${Number(payment.extension_days || 0)} kun` : `${plan.months} oy`}`);
  lines.push(`<b>Filial limiti:</b> ${branchLimit} ta`, "");
  lines.push(`<b>Summa:</b> ${money(payment.amount)} so'm`, `<b>Buyurtma:</b> ${escapeHtml(payment.order_id)}`, "");
  lines.push("<b>Yuborilgan vaqt:</b>", escapeHtml(submittedTime(payment.submitted_at)), "", "<b>Holat:</b>", "🟡 Tekshiruvda");
  return lines.join("\n");
}

export function createPaymentTelegramClient({ token, fetchImpl = fetch }) {
  const call = async (method, options) => {
    if (!token) throw new Error("Payment Telegram bot sozlanmagan");
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(15000), ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(`Payment Telegram ${method} xatosi: ${String(payload.description || response.status).slice(0, 300)}`);
    return payload.result;
  };
  const json = (method, body) => call(method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return {
    async sendPaymentReview(payment, callbackToken, chatId) {
      const text = formatPaymentReviewMessage(payment);
      const replyMarkup = { inline_keyboard: [[
        { text: "✅ Tasdiqlash", callback_data: `pa:${callbackToken}` },
        { text: "❌ Rad etish", callback_data: `pr:${callbackToken}` },
      ]] };
      if (payment.receipt_content && payment.receipt_type) {
        const isImage = new Set(["image/jpeg", "image/png"]).has(payment.receipt_type);
        const method = isImage ? "sendPhoto" : "sendDocument";
        const field = isImage ? "photo" : "document";
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set(field, new Blob([payment.receipt_content], { type: payment.receipt_type }), payment.receipt_name || "receipt");
        form.set("caption", text);
        form.set("parse_mode", "HTML");
        form.set("reply_markup", JSON.stringify(replyMarkup));
        return call(method, { method: "POST", body: form });
      }
      return json("sendMessage", { chat_id: String(chatId), text, parse_mode: "HTML", reply_markup: replyMarkup });
    },
    answerPaymentCallback(callbackQueryId, text, showAlert = false) {
      return json("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
    },
    editPaymentReviewMessage(chatId, messageId, text, { hasCaption = false } = {}) {
      const content = { chat_id: String(chatId), message_id: Number(messageId), parse_mode: "HTML", reply_markup: { inline_keyboard: [] } };
      content[hasCaption ? "caption" : "text"] = text;
      return json(hasCaption ? "editMessageCaption" : "editMessageText", content);
    },
  };
}

const paymentClient = createPaymentTelegramClient({ token: env.paymentBotToken });
export const sendPaymentReview = (...args) => paymentClient.sendPaymentReview(...args);
export const answerPaymentCallback = (...args) => paymentClient.answerPaymentCallback(...args);
export const editPaymentReviewMessage = (...args) => paymentClient.editPaymentReviewMessage(...args);
