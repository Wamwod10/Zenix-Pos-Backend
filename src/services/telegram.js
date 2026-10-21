import { telegramText as clean, telegramMoney as money, finiteNumber, telegramHeader } from './telegramFormat.js';
import { env } from "../config/env.js";

const apiBase = () => `https://api.telegram.org/bot${env.telegramBotToken}`;

export async function telegramRequest(method, payload = {}) {
  if (!env.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`${apiBase()}/${method}`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload), signal:AbortSignal.timeout(15000) });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

export const sendTelegramMessage = (chatId, text, extra = {}) => telegramRequest("sendMessage", { chat_id:chatId, text, parse_mode:"HTML", disable_web_page_preview:true, ...extra });

function notificationBody(eventType,payload={}){
  if(eventType==="sale.completed")return `🛒 <b>Yangi savdo</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\n👤 Kassir: ${clean(payload.sellerName)}\nSavdo: <b>${clean(payload.saleNumber)}</b>\nMahsulot qatorlari: ${finiteNumber(payload.lineCount??payload.itemCount??0)} ta${payload.quantityByUnit?`\n📦 Sotilgan miqdor: ${clean(payload.quantityByUnit)}`:""}\nJami: <b>${money(payload.total)}</b>`;
  if(eventType==="sale.returned")return `↩️ <b>Qaytarish</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\nSavdo: ${clean(payload.saleNumber)}\nXodim: ${clean(payload.userName)}\nMiqdor: ${finiteNumber(payload.quantity||0)} ${clean(payload.unit, "")}\nSumma: <b>${money(payload.amount)}</b>${payload.reason?`\nSabab: ${clean(payload.reason)}`:""}`;
  if(eventType==="shift.opened")return `🟢 <b>Smena ochildi</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\n👤 Kassir: ${clean(payload.cashierName)}\nBoshlang‘ich kassa: <b>${money(payload.openingCash)}</b>`;
  if(eventType==="shift.closed")return `📊 <b>Smena yopildi</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\n👤 Kassir: ${clean(payload.cashierName)}\n💵 Kutilgan kassa: <b>${money(payload.expectedCash)}</b>\n💰 Haqiqiy kassa: <b>${money(payload.actualCash)}</b>\n${finiteNumber(payload.difference)<0?"⚠️":"✅"} Farq: <b>${finiteNumber(payload.difference)>0?"+":""}${money(payload.difference)}</b>`;
  if(eventType==="inventory.received")return `📦 <b>Omborga kirim</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\nMahsulot qatori: ${finiteNumber(payload.lineCount||0)} ta\nJami xarid: <b>${money(payload.total)}</b>${payload.supplierName?`\nTa’minotchi: ${clean(payload.supplierName)}`:""}`;
  if(eventType==="inventory.transfer_dispatched")return `🚚 <b>Transfer jo‘natildi</b>\n\nQayerdan: <b>${clean(payload.fromStoreName)}</b>\nQayerga: <b>${clean(payload.toStoreName)}</b>\nMahsulotlar: ${finiteNumber(payload.lineCount||0)} ta\nJami miqdor: ${finiteNumber(payload.totalQuantity||0)}`;
  if(eventType==="inventory.transfer_received")return `✅ <b>Transfer qabul qilindi</b>\n\nQayerdan: <b>${clean(payload.fromStoreName)}</b>\nQayerga: <b>${clean(payload.toStoreName)}</b>\nMahsulotlar: ${finiteNumber(payload.lineCount||0)} ta\nQabul qilindi: ${finiteNumber(payload.receivedQuantity||0)}${payload.hasDifference?`\n⚠️ Farq bor${payload.differenceReason?`: ${clean(payload.differenceReason)}`:""}`:""}`;
  if(eventType==="inventory.transfer_cancelled")return `⛔ <b>Transfer bekor qilindi</b>\n\nQayerdan: <b>${clean(payload.fromStoreName)}</b>\nQayerga: <b>${clean(payload.toStoreName)}</b>\nHolat: ${clean(payload.previousStatus)}`;
  if(eventType==="inventory.low")return `⚠️ <b>Mahsulot kamayib qoldi</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\nMahsulot: <b>${clean(payload.productName)}</b>\nQoldiq: ${finiteNumber(payload.quantity||0)} ${clean(payload.unit, "")}\nMinimum: ${finiteNumber(payload.minStock||0)} ${clean(payload.unit, "")}`;
  if(eventType==="inventory.out")return `🚨 <b>Mahsulot tugadi</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\nMahsulot: <b>${clean(payload.productName)}</b>\nQoldiq: ${finiteNumber(payload.quantity||0)} ${clean(payload.unit, "")}`;
  if(eventType==="daily.report")return `📈 <b>Kunlik hisobot</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\nSana: ${clean(payload.businessDate)}\nSavdolar: ${finiteNumber(payload.saleCount||0)} ta\nSof savdo: <b>${money(payload.total)}</b>\n💰 To‘lovlar bo‘yicha sof tushum: <b>${money(finiteNumber(payload.cash)+finiteNumber(payload.card)+finiteNumber(payload.transfer))}</b>\nNaqd: ${money(payload.cash)}\nKarta: ${money(payload.card)}\nO‘tkazma: ${money(payload.transfer)}`;
  if(eventType==="expense.created")return `💸 <b>Yangi xarajat</b>\n\n🏪 Filial: <b>${clean(payload.storeName)}</b>\nXodim: ${clean(payload.userName)}\nKategoriya: ${clean(payload.category)}\nXarajat: ${clean(payload.title)}\nSumma: <b>${money(payload.amount)}</b>`;
  if(eventType==="supplier.debt")return `🧾 <b>Ta’minotchi qarzi</b>\n\n${payload.storeName?`Filial: <b>${clean(payload.storeName)}</b>\n`:""}Ta’minotchi: <b>${clean(payload.supplierName)}</b>${payload.invoiceNo?`\nNakladnoy: ${clean(payload.invoiceNo)}`:""}\nOchiq qarz: <b>${money(payload.debt)}</b>${payload.dueDate?`\nMuddat: ${clean(payload.dueDate)}`:""}`;
  return `🔔 <b>Zenix POS</b>\n\n${clean(payload.message||eventType)}`;
}

export function formatNotification(eventType, payload = {}) {
  payload ||= {};
  const body = notificationBody(eventType, payload);
  const [title, ...lines] = body.split('\n\n');
  const reportStatus = eventType === 'daily.report' && payload.reportKind ? (payload.reportKind === 'final' ? '✅ <b>Yakuniy kun yopilishi</b>\n\n' : '🕒 <b>Oraliq hisobot</b>\n\n') : '';
  return telegramHeader(title) + reportStatus + lines.join('\n\n').split(/\n+/u).join('\n\n');
}
