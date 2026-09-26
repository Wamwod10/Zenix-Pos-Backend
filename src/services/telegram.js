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

const money=(value)=>new Intl.NumberFormat("uz-UZ").format(Number(value||0))+" so‘m";
const clean=(value,fallback="—")=>{const raw=String(value??"").trim()||fallback;return raw.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");};
export function formatNotification(eventType,payload={}){
  if(eventType==="sale.completed")return `🛒 <b>Yangi savdo</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nKassir: ${clean(payload.sellerName)}\nSavdo: <b>${clean(payload.saleNumber)}</b>\nMahsulotlar: ${Number(payload.itemCount||0)} ta\nJami: <b>${money(payload.total)}</b>`;
  if(eventType==="sale.returned")return `↩️ <b>Qaytarish</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nSavdo: ${clean(payload.saleNumber)}\nXodim: ${clean(payload.userName)}\nMiqdor: ${Number(payload.quantity||0)}\nSumma: <b>${money(payload.amount)}</b>${payload.reason?`\nSabab: ${clean(payload.reason)}`:""}`;
  if(eventType==="shift.opened")return `🟢 <b>Smena ochildi</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nKassir: ${clean(payload.cashierName)}\nBoshlang‘ich kassa: <b>${money(payload.openingCash)}</b>`;
  if(eventType==="shift.closed")return `📊 <b>Smena yopildi</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nKassir: ${clean(payload.cashierName)}\nKutilgan kassa: <b>${money(payload.expectedCash)}</b>\nHaqiqiy kassa: <b>${money(payload.actualCash)}</b>\nFarq: <b>${money(payload.difference)}</b>`;
  if(eventType==="inventory.received")return `📦 <b>Omborga kirim</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nMahsulot qatori: ${Number(payload.lineCount||0)} ta\nJami xarid: <b>${money(payload.total)}</b>${payload.supplierName?`\nTa’minotchi: ${clean(payload.supplierName)}`:""}`;
  if(eventType==="inventory.transfer_dispatched")return `🚚 <b>Transfer jo‘natildi</b>\n\nQayerdan: <b>${clean(payload.fromStoreName)}</b>\nQayerga: <b>${clean(payload.toStoreName)}</b>\nMahsulotlar: ${Number(payload.lineCount||0)} ta\nJami miqdor: ${Number(payload.totalQuantity||0)}`;
  if(eventType==="inventory.transfer_received")return `✅ <b>Transfer qabul qilindi</b>\n\nQayerdan: <b>${clean(payload.fromStoreName)}</b>\nQayerga: <b>${clean(payload.toStoreName)}</b>\nMahsulotlar: ${Number(payload.lineCount||0)} ta\nQabul qilindi: ${Number(payload.receivedQuantity||0)}${payload.hasDifference?`\n⚠️ Farq bor${payload.differenceReason?`: ${clean(payload.differenceReason)}`:""}`:""}`;
  if(eventType==="inventory.transfer_cancelled")return `⛔ <b>Transfer bekor qilindi</b>\n\nQayerdan: <b>${clean(payload.fromStoreName)}</b>\nQayerga: <b>${clean(payload.toStoreName)}</b>\nHolat: ${clean(payload.previousStatus)}`;
  if(eventType==="inventory.low")return `⚠️ <b>Mahsulot kamayib qoldi</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nMahsulot: <b>${clean(payload.productName)}</b>\nQoldiq: ${Number(payload.quantity||0)}\nMinimum: ${Number(payload.minStock||0)}`;
  if(eventType==="inventory.out")return `🚨 <b>Mahsulot tugadi</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nMahsulot: <b>${clean(payload.productName)}</b>\nQoldiq: ${Number(payload.quantity||0)}`;
  if(eventType==="daily.report")return `📈 <b>Kunlik hisobot</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nSana: ${clean(payload.businessDate)}\nSavdolar: ${Number(payload.saleCount||0)} ta\nSof tushum: <b>${money(payload.total)}</b>\nNaqd: ${money(payload.cash)}\nKarta: ${money(payload.card)}\nO‘tkazma: ${money(payload.transfer)}`;
  if(eventType==="expense.created")return `💸 <b>Yangi xarajat</b>\n\nFilial: <b>${clean(payload.storeName)}</b>\nXodim: ${clean(payload.userName)}\nKategoriya: ${clean(payload.category)}\nXarajat: ${clean(payload.title)}\nSumma: <b>${money(payload.amount)}</b>`;
  if(eventType==="supplier.debt")return `🧾 <b>Ta’minotchi qarzi</b>\n\n${payload.storeName?`Filial: <b>${clean(payload.storeName)}</b>\n`:""}Ta’minotchi: <b>${clean(payload.supplierName)}</b>${payload.invoiceNo?`\nNakladnoy: ${clean(payload.invoiceNo)}`:""}\nOchiq qarz: <b>${money(payload.debt)}</b>${payload.dueDate?`\nMuddat: ${clean(payload.dueDate)}`:""}`;
  return `🔔 <b>Zenix POS</b>\n\n${clean(payload.message||eventType)}`;
}
