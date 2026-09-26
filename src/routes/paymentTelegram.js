import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { reviewBillingPayment } from "../services/billingReview.js";
import { answerPaymentCallback, editPaymentReviewMessage, hashPaymentReviewToken } from "../services/paymentTelegram.js";

const router = Router();
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const secretMatches = (received, expected) => {
  const left = Buffer.from(String(received || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && right.length > 0 && timingSafeEqual(left, right);
};

export const isAuthorizedPaymentAdmin = ({ chatId, userId, adminChatId, adminUserIds }) => (
  String(chatId) === String(adminChatId) && new Set((adminUserIds || []).map(String)).has(String(userId))
);

export const parsePaymentCallbackData = (data) => {
  const match = String(data || "").match(/^p([ar]):([A-Za-z0-9_-]{24})$/);
  if (!match) return null;
  return { decision: match[1] === "a" ? "APPROVED" : "REJECTED", token: match[2] };
};

const finalMessage = ({ decision, admin, orderId }) => {
  const approved = decision === "APPROVED";
  const reviewer = admin.username ? `@${admin.username}` : `Telegram ID ${admin.id}`;
  const time = new Intl.DateTimeFormat("uz-UZ", { timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short" }).format(new Date());
  return [
    approved ? "<b>✅ TASDIQLANDI</b>" : "<b>❌ RAD ETILDI</b>", "",
    `<b>Kim:</b> ${escapeHtml(reviewer)}`,
    `<b>Vaqt:</b> ${escapeHtml(time)}`,
    `<b>Buyurtma:</b> ${escapeHtml(orderId)}`,
  ].join("\n");
};

export async function handlePaymentCallback(update, {
  db = pool,
  reviewPayment = reviewBillingPayment,
  answerCallback = answerPaymentCallback,
  editMessage = editPaymentReviewMessage,
  config = env,
} = {}) {
  const callback = update?.callback_query;
  if (!callback) return "ignored";
  const chatId = String(callback.message?.chat?.id || "");
  const userId = String(callback.from?.id || "");
  if (!isAuthorizedPaymentAdmin({ chatId, userId, adminChatId: config.paymentAdminChatId, adminUserIds: config.paymentAdminUserIds })) {
    await answerCallback(callback.id, "Bu amal uchun ruxsat yo'q.", true).catch(() => {});
    return "unauthorized";
  }
  const parsed = parsePaymentCallbackData(callback.data);
  if (!parsed) {
    await answerCallback(callback.id, "Noto'g'ri yoki eskirgan tugma.", true).catch(() => {});
    return "invalid";
  }
  const payment = (await db.query(`SELECT id,status,order_id,telegram_review_token_expires_at
    FROM billing_payments WHERE telegram_review_token_hash=$1`, [hashPaymentReviewToken(parsed.token)])).rows[0];
  if (!payment || payment.status !== "REVIEW") {
    await answerCallback(callback.id, "Bu to'lov allaqachon ko'rib chiqilgan.").catch(() => {});
    return "alreadyReviewed";
  }
  if (payment.telegram_review_token_expires_at && new Date(payment.telegram_review_token_expires_at).getTime() <= Date.now()) {
    await answerCallback(callback.id, "Tasdiqlash tugmasining muddati tugagan.", true).catch(() => {});
    return "expired";
  }
  const actor = {
    source: "telegram", telegramUserId: userId, telegramUsername: String(callback.from?.username || ""), telegramChatId: chatId,
  };
  const result = await reviewPayment({ paymentId: payment.id, decision: parsed.decision, reason: parsed.decision === "REJECTED" ? "Telegram admin tomonidan rad etildi" : "", actor });
  if (result.outcome === "alreadyReviewed") {
    await answerCallback(callback.id, "Bu to'lov allaqachon ko'rib chiqilgan.").catch(() => {});
    return "alreadyReviewed";
  }
  await answerCallback(callback.id, parsed.decision === "APPROVED" ? "To'lov tasdiqlandi." : "To'lov rad etildi.").catch(() => {});
  const text = finalMessage({ decision: parsed.decision, admin: callback.from, orderId: result.payment?.order_id || payment.order_id });
  await editMessage(chatId, callback.message.message_id, text, { hasCaption: Boolean(callback.message?.caption) })
    .catch((error) => console.error("[payment-telegram-webhook] message edit failed", String(error?.message || error).slice(0, 200)));
  return result.outcome;
}

router.post("/webhook", asyncRoute(async (req, res) => {
  if (!secretMatches(req.get("x-telegram-bot-api-secret-token"), env.paymentWebhookSecret)) {
    throw new HttpError(403, "Telegram payment webhook tasdiqlanmadi", "PAYMENT_WEBHOOK_FORBIDDEN");
  }
  await handlePaymentCallback(req.body);
  ok(res, { accepted: true });
}));

export default router;
