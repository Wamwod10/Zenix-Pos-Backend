import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env.js";
import { BILLING_PLANS } from "../config/billing.js";
import {subscriptionPlan} from '../config/subscriptions.js';

import { telegramText as escapeHtml, telegramMoney as money, telegramTime as submittedTime, telegramHeader } from './telegramFormat.js';

export const derivePaymentReviewToken = (paymentId, secret) => createHmac("sha256", String(secret)).update(`zenix-payment-review:${paymentId}`).digest("base64url").slice(0, 24);
export const hashPaymentReviewToken = (token) => createHash("sha256").update(String(token)).digest("hex");

const displayText = (value, limit) => escapeHtml(typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : value, '—', limit);

export function formatPaymentReviewMessage(payment, actor = {}) {
  const plan = BILLING_PLANS[payment.plan] || BILLING_PLANS.ANNUAL;
  const isExtra = payment.type === "EXTRA";
  const quote=payment.draft_metadata?.subscription;
  const tier=quote?subscriptionPlan(quote.planCode,quote.pricingVersion):null;
  const branchLimit = isExtra
    ? Number(payment.store_limit || 0) + Math.max(1, Number(payment.extra_store_count || 1))
    : tier?tier.limits.stores+Number(quote.legacyStoreBonus||0):plan.includedStores + Math.max(0, Number(payment.extra_store_count || 0));
  const lines = [
    telegramHeader('💳 <b>Obuna to‘lovi</b>').trimEnd(),
    '🏢 Biznes: <b>' + displayText(payment.organization_name, 64) + '</b>',
    '👤 Egasi: ' + displayText(payment.owner_name, 48),
  ];
  if (payment.owner_phone) lines.push('📱 Telefon: ' + escapeHtml(payment.owner_phone));
  lines.push('💎 Tarif: <b>' + (isExtra ? 'Qo‘shimcha filial' : escapeHtml(tier ? tier.label + ' / ' + plan.label : plan.label)) + '</b>');
  lines.push('📅 Muddat: ' + (isExtra ? Number(payment.extension_days || 0) + ' kun' : plan.months + ' oy'));
  lines.push('🏪 Filial limiti: ' + branchLimit + ' ta', '💰 Summa: <b>' + money(payment.amount) + '</b>');
  lines.push('🧾 Buyurtma: ' + escapeHtml(payment.order_id), '🕒 Yuborilgan: ' + submittedTime(payment.submitted_at));
  lines.push('━━━━━━━━━━━━');
  if (payment.status === 'APPROVED' || payment.status === 'REJECTED') {
    const approved = payment.status === 'APPROVED';
    lines.push(approved ? '✅ <b>TO‘LOV TASDIQLANDI</b>' : '❌ <b>TO‘LOV RAD ETILDI</b>');
    const reviewer = actor.telegramUsername ? '@' + actor.telegramUsername : actor.telegramUserId ? 'Telegram ID ' + actor.telegramUserId : actor.internalUserId ? 'Administrator ' + actor.internalUserId : '—';
    lines.push('👨‍💻 ' + (approved ? 'Tasdiqladi' : 'Rad etdi') + ': ' + escapeHtml(reviewer));
    lines.push('🕒 Vaqt: ' + submittedTime(payment.reviewed_at));
    if (!approved && payment.reject_reason) lines.push('📝 Sabab: ' + displayText(payment.reject_reason, 160));
  } else lines.push('🟡 <b>Tekshiruvda</b>');
  return lines.join("\n\n");
}

export function createPaymentTelegramClient({ token, fetchImpl = fetch }) {
  const call = async (method, options) => {
    if (!token) throw new Error("Payment Telegram bot sozlanmagan");
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(15000), ...options }).catch(() => { throw new Error(`Payment Telegram ${method}: transport xatosi`); });
    const payload = await response.json().catch(() => ({}));
    if (payload.description?.includes("message is not modified")) return null;
    if (!response.ok || !payload.ok) throw new Error(`Payment Telegram ${method} xatosi: ${response.status || "API"}`);
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
        form.set("caption", text.length <= 1024 ? text : telegramHeader("🧾 <b>To‘lov cheki</b>") + '🧾 Buyurtma: <b>' + escapeHtml(payment.order_id) + '</b>\n\nTo‘lov tafsilotlari quyidagi xabarda.');
        form.set("parse_mode", "HTML");
        if (text.length <= 1024) form.set("reply_markup", JSON.stringify(replyMarkup));
        const receipt = await call(method, { method: "POST", body: form });
        if (text.length <= 1024) return receipt;
        return json("sendMessage", {chat_id:String(chatId),text,parse_mode:"HTML",reply_markup:replyMarkup,reply_parameters:{message_id:receipt.message_id}});
      }
      return json("sendMessage", { chat_id: String(chatId), text, parse_mode: "HTML", reply_markup: replyMarkup });
    },
    answerPaymentCallback(callbackQueryId, text, showAlert = false) {
      return json("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
    },
    async editPaymentReviewMessage(chatId, messageId, text, { hasCaption = false, detailsMessageId = null, onDetailsMessage = async () => {} } = {}) {
      const content = { chat_id: String(chatId), message_id: Number(messageId), parse_mode: "HTML", reply_markup: { inline_keyboard: [] } };
      if (hasCaption && text.length > 1024) {
        // Checkpoint the reply before editing the receipt. Retrying a failed
        // caption edit reuses this reply and preserves the photo/PDF.
        if (detailsMessageId) await json('editMessageText',{...content,message_id:Number(detailsMessageId),text});
        else {
          const details = await json('sendMessage',{chat_id:String(chatId),text,parse_mode:'HTML',reply_parameters:{message_id:Number(messageId)}});
          await onDetailsMessage(details.message_id);
        }
        const summary=text.split('\n').filter(line=>line.startsWith('🧾 Buyurtma:') || line.includes('<b>TO‘LOV ')).join('\n\n');
        return json('editMessageCaption', {...content,caption:telegramHeader('💳 <b>Obuna to‘lovi</b>') + summary + '\n\nTo‘liq qaror quyidagi xabarda.'});
      }
      content[hasCaption ? "caption" : "text"] = text;
      return json(hasCaption ? "editMessageCaption" : "editMessageText", content);
    },
  };
}

const paymentClient = createPaymentTelegramClient({ token: env.paymentBotToken });
export const sendPaymentReview = (...args) => paymentClient.sendPaymentReview(...args);
export const answerPaymentCallback = (...args) => paymentClient.answerPaymentCallback(...args);
export const editPaymentReviewMessage = (...args) => paymentClient.editPaymentReviewMessage(...args);
