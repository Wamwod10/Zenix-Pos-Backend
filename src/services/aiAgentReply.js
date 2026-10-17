import {createHash} from 'node:crypto';
import {HttpError} from '../lib/http.js';

export function assertAgentQuestion(value){
 const text=String(value||'').normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g,'').trim();
 if(!text||text.length>1000||/(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|system\s*prompt|api[_\s-]?key|parol|password|secret|boshqa\s+(?:biznes|tenant|tashkilot)|select\s+.+\s+from|\b(?:drop\s+table|delete\s+from|insert\s+into|update\s+users)\b)/iu.test(text))throw new HttpError(400,'Savol biznes amallari uchun mos emas','AI_UNSAFE_QUESTION');
 return text;
}
function deterministicAnswer(reply,toolResults){
 const results=toolResults.map(t=>t.result);
 const clarification=results.findLast(r=>r.kind==='clarification');
 if(clarification)return clarification.message;
 const parts=[];
 for(const r of results){
  if(r.kind==='products')parts.push(r.candidates.length?r.candidates.map(p=>`${p.name} (${p.unit})`).join('\n'):'Mahsulot topilmadi. Nom yoki shtrix-kodni aniqlashtiring.');
  if(r.kind==='products'&&r.candidates.length>1)parts.push('Bir nechta mahsulot topildi. Qaysi mahsulotni nazarda tutdingiz?');
  if(r.kind==='stock')parts.push(`${r.productName}:\n${r.locations.map(l=>`${l.storeName||''} · ${l.warehouseName}: ${l.quantity} ${r.unit}`).join('\n')||'Ushbu doirada qoldiq ma’lumoti yo‘q.'}`);
  if(r.kind==='locations')parts.push(r.locations.map(l=>`${l.storeName} · ${l.warehouseName}`).join('\n')||'Ruxsat etilgan ombor topilmadi.');
  if(r.kind==='report')parts.push(r.report.facts.map(f=>`${f.label}: ${f.value===null?'Ma’lumot yetarli emas':`${f.value} ${f.unit==='UZS'?'so‘m':f.unit==='count'?'ta':f.unit||''}`}`).join('\n')||'Hisobotda yetarli ma’lumot mavjud emas.');
  if(r.kind==='action')parts.push(`${r.action.preview.productName}: +${r.action.preview.quantity} ${r.action.preview.unit}, ${r.action.preview.warehouseName}. Kirim kartasi tayyor. Bajarish uchun kartadagi tasdiqlash tugmasidan foydalaning.`);
 }
 if(parts.length)return parts.filter(Boolean).join('\n\n');
 // A model category never proves a business fact or completed operation.
 // Unverified prose, including amounts written in words, is never rendered.
 if(reply?.kind==='greeting')return 'Salom! Mahsulot, qoldiq, biznes hisoboti yoki ombor kirimi haqida so‘rashingiz mumkin.';
 if(reply?.kind==='advice')return 'Umumiy tavsiya: qaror qilishdan oldin savdo, xarajat va qoldiq hisobotlarini birgalikda tekshiring. Sabab yoki prognoz uchun yetarli tarixiy dalil kerak.';
 if(reply?.kind==='clarification')return 'Mahsulot, ombor yoki kerakli hisobotni aniqlashtiring.';
 return 'Bu savol uchun tasdiqlangan ma’lumot yetarli emas. Mahsulot yoki kerakli hisobotni aniqlashtiring. Hozir faqat ombor kirimi uchun tasdiqlash kartasi tayyorlanishi mumkin.';
}

export function buildAgentEvidence(toolResults){
 const seen=new Map();
 for(const entry of toolResults){
  const r=entry.result;
  if(!['products','stock','locations','report','action'].includes(r?.kind))continue;
  const report=r.report;
  const scope=report?.storeId?'Tanlangan filial':'Ruxsat etilgan barcha filiallar';
  const prefix=report?.topic==='business_overview'?scope+'\n':report?.from&&report?.to?`${report.comparisonFrom?`Joriy davr: ${report.from} - ${report.to}; Taqqoslash davri: ${report.comparisonFrom} - ${report.comparisonTo}`:`Hisobot davri: ${report.from} - ${report.to}`}; ${scope}\n`:report?scope+'\n':'';
  const fragments=report?[
   ...([reportSummary(report)].filter(Boolean)),
   ...(report.notes||[]).map(note=>prefix+note),
   ...(report.facts||[]).map(f=>(f.from&&f.to?`Hisobot davri: ${f.from} - ${f.to}; ${scope}\n`:prefix)+deterministicAnswer(null,[{result:{kind:'report',report:{facts:[f]}}}])),
   ...(report.tables||[]).flatMap(t=>(t.rows||[]).slice(0,10).map(row=>(t.from&&t.to?`Hisobot davri: ${t.from} - ${t.to}; ${scope}\n`:prefix)+t.title+': '+t.columns.map((column,i)=>column+': '+row[i]).join('; '))),
  ]:r.kind==='stock'&&r.locations?.length?r.locations.map(location=>deterministicAnswer(null,[{result:{...r,locations:[location]}}])):r.kind==='locations'&&r.locations?.length?r.locations.map(location=>deterministicAnswer(null,[{result:{...r,locations:[location]}}])):[deterministicAnswer(null,[entry])];
  for(const fragment of fragments){
   const text=fragment;
   const id='f'+createHash('sha256').update(JSON.stringify(r)).update(text).digest('hex').slice(0,24);
   seen.set(id,{id,text});
  }
 }
 const output=[];let bytes=0;
 for(const item of [...seen.values()]){const size=Buffer.byteLength(item.text)+item.id.length;if(output.length>=20)break;if(bytes+size>4000)continue;output.push(item);bytes+=size;}
 return output;
}
const evidenceError=reason=>new HttpError(502,'AI javobi dalil bilan tasdiqlanmadi','AI_EVIDENCE_INVALID',{stage:'evidence',reason});
export const repairableAgentReply=error=>error instanceof HttpError&&(
 error.code==='AI_EVIDENCE_INVALID'&&['unsupported_numeric_claim','unsupported_business_assertion','unknown_anchor','malformed_anchor','invalid_blocks'].includes(error.details?.reason)||
 error.code==='AI_INVALID_RESPONSE'&&error.details?.stage==='parse'&&error.details?.reason==='schema_mismatch'
);
function overviewSummary(report){
 const facts=report.facts||[],pick=id=>facts.find(f=>f.id===id&&typeof f.value==='string'&&/^-?\d+(?:\.\d+)?$/.test(f.value));
 const number=value=>{const [whole,fraction]=value.split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,' ')+(fraction&&!/^0+$/.test(fraction)?'.'+fraction:'')};
 const money=f=>number(f.value)+' so‘m',parts=[`${report.storeId?'Tanlangan filial':'Ruxsat etilgan filiallar'} bo‘yicha hisobotlardan tayyorlangan qisqa xulosa:`];
 if(report.sellerScoped&&facts.some(f=>/^today_sales_|^profit_profit_/.test(f.id)))parts.push('Savdo va mahsulot foydasi faqat o‘z savdolaringiz bo‘yicha; bu butun filial savdosi emas.');
 const sales=pick('today_sales_today_net'),count=pick('today_sales_sales_count');
 if(sales)parts.push(`Bugun (${sales.to||report.to}): ro‘yxatga olingan sof savdo ${money(sales)}${count?`, savdolar soni ${number(count.value)} ta`:''}. Bu ko‘rsatkichning o‘zi savdo o‘sgani yoki pasayganini isbotlamaydi.`);
 const available=pick('inventory_warehouse_available_products'),low=pick('inventory_warehouse_low_stock_count');
 if(available||low)parts.push(`Qoldiqning joriy holati: ${[available?`${number(available.value)} ta mahsulotda musbat qoldiq bor`:null,low?`minimum yoki undan past qoldiqdagi mahsulotlar ${number(low.value)} ta`:null].filter(Boolean).join('; ')}. Bu mahsulot turlari soni, umumiy dona yoki kilogramm emas.`);
 const customer=pick('customer_debt_customer_debt'),supplier=pick('supplier_debt_supplier_debt');
 if(customer||supplier)parts.push(`Joriy qarzlar: ${[customer?`mijozlardan olinadigan ${money(customer)}`:null,supplier?`ta’minotchilarga to‘lanadigan ${money(supplier)}`:null].filter(Boolean).join('; ')}. To‘lov muddatlari bu hisobotda tekshirilmagan.`);
 const expense=pick('expenses_expenses');
 if(expense)parts.push(`Xarajat yozuvlari (${expense.from||report.from} — ${expense.to||report.to}): ${money(expense)}.${/^0(?:\.0+)?$/.test(expense.value)?' Bu biznesda umuman xarajat yo‘q degani emas; kiritilgan yozuvlarni tekshiring.':''}`);
 const profit=facts.filter(f=>/^profit_profit_\d+$/.test(f.id)&&typeof f.value==='string'&&/^-?\d+(?:\.\d+)?$/.test(f.value)).slice(0,3);
 if(profit.length)parts.push(`Mahsulot foydasi (${profit[0].from||report.from} — ${profit[0].to||report.to}):\n${profit.map(f=>`• ${f.label}: ${money(f)}`).join('\n')}\nBu tanlangan mahsulotlar foydasi, biznesning jami sof foydasi emas.`);
 if(facts.some(f=>/^profit_profit_\d+$/.test(f.id)&&f.value===null))parts.push('Ayrim mahsulotlarning tarixiy tannarxi yetarli emas, shu sabab ularning foydasi hisoblanmagan.');
 if(parts.length===1)return null;
 parts.push(supplier?'Keyingi qadam: ta’minotchi hujjatlaridagi to‘lov muddatlarini tekshiring. Umumiy sof foydani baholash uchun to‘liq tannarx va xarajat ma’lumotlari kerak.':sales?'Keyingi qadam: savdoni oldingi teng davr bilan solishtiring. Shundan keyingina o‘sish yoki pasayishni baholash mumkin.':'Keyingi qadam: kerakli bo‘limning batafsil hisobotini tekshiring.');
 return parts.join('\n\n');
}
const decimal=value=>typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value);
const displayDecimal=value=>{const [whole,fraction='']=value.split('.');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,' ')+(fraction.replace(/0+$/,'')?'.'+fraction.replace(/0+$/,''):'')};
function reportSummary(report){
 const scope=report.storeId?'Tanlangan filial':'Ruxsat etilgan barcha filiallar';
 const context=`${scope}${report.sellerScoped?' — faqat o‘z savdolaringiz':''}`;
 if(report.topic==='latest_sale'){
  const sale=report.sale;
  if(sale===null)return `${context}: savdo topilmadi.`;
  if(!sale||!decimal(sale.total))return null;
  const parts=[`${report.selection==='by_id'?'Tanlangan savdo hujjati':'Oxirgi savdo'} (${sale.businessDate}; ${sale.createdAt}): jami ${displayDecimal(sale.total)} so‘m.`,context+'.'];
  for(const item of (sale.items||[]).slice(0,3))if(decimal(item.quantity))parts.push(`${item.name}: ${displayDecimal(item.quantity)} ${item.unit}${decimal(item.lineTotal)?`, summa ${displayDecimal(item.lineTotal)} so‘m`:''}.`);
  if(sale.hasMoreItems)parts.push('Mahsulot qatorlari cheklangan; batafsil ma’lumotlar ham to‘liq emas. Jami summa barcha mahsulotlarni qamrab oladi.');
  else if((sale.items||[]).length>3)parts.push('Qolgan mahsulotlar batafsil ma’lumotlarda.');
  if(decimal(sale.returnedAmount)&&!/^0(?:\.0+)?$/.test(sale.returnedAmount))parts.push(`Qaytarilgan summa: ${displayDecimal(sale.returnedAmount)} so‘m.`);
  return parts.join('\n');
 }
 if(report.topic!=='top_products')return null;
 const rows=(report.facts||[]).filter(f=>/^top_products_\d+$/.test(f.id)&&f.productName&&decimal(f.qty));
 const heading=`${report.from} — ${report.to}; ${context}.`;
 if(!rows.length)return (report.facts||[]).some(f=>/^top_products_\d+$/.test(f.id))?null:`${heading}\nBu davrda savdo ma’lumoti topilmadi.`;
 const sameQuantity=(a,b)=>{const [aw,af='']=a.split('.'),[bw,bf='']=b.split('.');return BigInt(aw)===BigInt(bw)&&af.replace(/0+$/,'')===bf.replace(/0+$/,'')&&a.startsWith('-')===b.startsWith('-')};
 const first=rows[0],ties=rows.filter(f=>f.quantityUnit===first.quantityUnit&&sameQuantity(f.qty,first.qty));
 const mixed=new Set(rows.map(f=>f.quantityUnit)).size>1;
 const parts=[`${mixed?'Sof miqdor bo‘yicha ro‘yxat boshidagi mahsulotlar':ties.length>1?'Ko‘rsatilgan natijalarda sof miqdor bo‘yicha teng yetakchilar':'Sof miqdor bo‘yicha ro‘yxat boshida'}: ${ties.slice(0,3).map(f=>`${f.productName} — ${displayDecimal(f.qty)} ${f.quantityUnit||''}`).join('; ')}.`,heading];
 for(const row of rows.slice(0,3))if(decimal(row.value))parts.push(`${row.productName}: Sof savdo ${displayDecimal(row.value)} so‘m.`);
 parts.push('Sof miqdor qaytarishlar ayirilgan miqdor; sof savdo tushum bo‘lib, foyda emas.');
 if(mixed)parts.push('Turli o‘lchov birliklaridagi miqdorlarni bevosita solishtirib bo‘lmaydi.');
 return parts.join('\n');
}
export const isBusinessImprovementQuestion=question=>/biznes|savdo|foyda|daromad/iu.test(question||'')&&/qanday|maslahat|tavsiya|nima/iu.test(question||'')&&/yaxshila|rivojlantir|oshir|ko[‘’ʻʼ']paytir/iu.test(question||'');
function improvementFallback(report){
 const facts=report?.facts||[],pick=id=>facts.find(f=>f.id===id&&decimal(f.value));
 const positive=f=>f&&!f.value.startsWith('-')&&!/^0(?:\.0+)?$/.test(f.value);
 const show=(f,label)=>`${label}: ${displayDecimal(f.value)} ${f.unit==='UZS'?'so‘m':'ta'}${f.from&&f.to?` (${f.from} — ${f.to})`:''}.`;
 const supplier=pick('supplier_debt_supplier_debt'),customer=pick('customer_debt_customer_debt'),low=pick('inventory_warehouse_low_stock_count');
 const steps=[];
 if(positive(supplier)||positive(customer))steps.push(`${[positive(customer)&&show(customer,'Olinadigan qarz'),positive(supplier)&&show(supplier,'To‘lanadigan qarz')].filter(Boolean).join(' ')} To‘lov muddatlari tekshirilmagan. Amal: hujjatlarni muddat va kontragent bo‘yicha solishtiring. Keyingi qadam: muddatlarni tasdiqlab, undirish va to‘lov rejasini tuzing; to‘lov avtomatik bajarilmaydi.`);
 if(positive(low))steps.push(`${show(low,'Minimum yoki undan past qoldiqdagi mahsulot turlari')} Talab o‘zgarishi bu qoldiqdan aniqlanmaydi. Amal: mahsulot kesimida qoldiq, sof sotuv va yetkazish muddatini tekshiring. Keyingi qadam: shundan keyin kerakli kirim rejasini alohida tasdiqlang.`);
 steps.push('Amal: mahsulot kesimida tarixiy tannarx, qaytarish va xarajat yozuvlarini solishtiring. Keyingi qadam: yetishmayotgan hujjatlarni to‘ldirib, marjani qayta tekshiring; biznesning jami sof foydasini mahsulot foydasiga tenglashtirmang.');
 steps.push('Amal: savdoni oldingi teng davr bilan mahsulot va filial kesimida solishtiring. Keyingi qadam: farq ko‘ringandan keyin kichik sinov tanlang va natijani yana o‘lchang; o‘sish kafolatlanmaydi.');
 steps.push('Amal: ruxsat etilgan qoldiq va xarajat hisobotlarini tekshiring. Keyingi qadam: yozuvlarni hujjatlar bilan solishtirib, ustuvor ishni mas’ulga biriktiring.');
 const scope=report?`${report.storeId?'Tanlangan filial':'Ruxsat etilgan filiallar'}${report.sellerScoped?' — savdo va mahsulot foydasi faqat o‘z savdolaringiz bo‘yicha':''}. `:'';
 return {answerSource:facts.some(f=>decimal(f.value))?'verified_fallback':'clarification_fallback',answer:`Qisqa xulosa: avval pul oqimi, qoldiq va marjani dalil bilan tekshirib, keyin sinovli o‘zgarish qiling.\n\nAsosiy muammolar va ma’lumot chegarasi: ${scope}Sabablar, talab va o‘sishni bu ma’lumotlardan aniqlab bo‘lmaydi. Teng davrlar taqqoslovi, to‘liq tannarx va xarajat hujjatlari tekshirilishi kerak.\n\nEng muhim tavsiyalar:\n${steps.slice(0,3).map((step,i)=>`${i+1}. ${step}`).join('\n\n')}`};
}
export function safeAgentFallback(evidence,toolResults=[],{question}={}){
 const latestReport=toolResults.findLast(t=>t.result?.kind==='report')?.result.report;
 if(isBusinessImprovementQuestion(question)&&!toolResults.some(t=>['action','clarification'].includes(t.result?.kind)))return improvementFallback(latestReport);
 const summary=latestReport?.topic==='business_overview'&&overviewSummary(latestReport);
 if(summary)return {answerSource:'verified_fallback',answer:summary};
 const report=latestReport&&['top_products','latest_sale'].includes(latestReport.topic)?latestReport:null;
 const direct=report&&reportSummary(report);
 if(direct)return {answerSource:'verified_fallback',answer:direct};
 if(latestReport)evidence=buildAgentEvidence([{result:{kind:'report',report:latestReport}}]);
 return evidence.length?{answerSource:'verified_fallback',answer:'Tekshirilgan ma’lumotlar bo‘yicha qisqa xulosa:\n\n'+evidence.slice(0,3).map(f=>f.text).join('\n\n')+'\n\nQolgan ko‘rsatkichlar batafsil ma’lumotlarda berilgan.'}:
  {answerSource:'clarification_fallback',answer:'Javobni ishonchli ma’lumot bilan tasdiqlay olmadim. Savolni aniqlashtiring yoki kerakli hisobot, mahsulot va filialni ko‘rsating.'};
}
export function validateAgentReplyEvidence(reply,evidence=[]){
 const text=reply.reply.normalize('NFKC'),known=new Map(evidence.map(f=>[f.id,f.text]));
 const anchors=[...text.matchAll(/\{\{([^{}]+)\}\}/g)];
 if(anchors.some(m=>!known.has(m[1])))throw evidenceError('unknown_anchor');
 const prose=text.replace(/\{\{[^{}]+\}\}/g,'');
 if(/[{}]/.test(prose))throw evidenceError('malformed_anchor');
 // Conservative syntactic guards do not prove arbitrary prose semantically.
 if(/(?:kiritildi|bajarildi|tasdiqlandi|to[‘’ʻʼ']landi|bekor qilindi|executed|confirmed|cancelled|deleted)/iu.test(prose))throw evidenceError('execution_claim');
 const statements=prose.replace(/[^.!?\n]*\?/gu,'');
 if(/\b(?:kamaydi|oshdi|sotildi|tashkil etdi)[.!]?(?:\s|$)/iu.test(statements))throw evidenceError('unsupported_business_assertion');
 if(/\b(?:oshadi|o[‘’ʻʼ']sadi|ko[‘’ʻʼ']payadi|kamayadi|pasayadi)(?:\s+albatta)?\s*(?:[.!?,;]|$)/iu.test(statements))throw evidenceError('unsupported_business_assertion');
 // Exempt only explicit check/compare objects and hypothetical clauses, not
 // whole advice sentences: a factual assertion later in the sentence stays checked.
 const business='(?:mahsulot|savdo|foyda|daromad|ombor|qoldiq|xarajat|qarz)(?:lar)?i?ngiz';
 const claims=statements.replace(/\b(?:savdongizni|foydangizni|daromadingizni)\s+(?:tahlil qilish|oshirish|tekshirish)\s+uchun\b/giu,'')
  .replace(new RegExp('\\b'+business+'ni(?=\\s+(?:tekshiring|solishtiring|tahlil qiling|nazorat qiling)(?:[.!?,;:]|\\s|$))','giu'),'')
  .replace(new RegExp('\\bagar\\s+'+business+'\\s+(?:kam|past|yuqori)\\s+bo[‘’ʻʼ\']lsa\\b','giu'),'');
 if(/(?:mahsulot|savdo|foyda|daromad|ombor|qoldiq|xarajat|qarz)\w*i?ngiz|\b(?:yakunlangan|pasaygan|qimmatlashgan|sotiladigan)\b|\bBu\s+zarar\s+ko[‘’']rsatkichi/iu.test(claims))throw evidenceError('unsupported_business_assertion');
 // Numbered advice is presentation, not a business statistic. All other
 // quantities (including numbers written in Uzbek words) require an anchor.
 const count='(?:\\d{1,2}|bir|ikki|uch|besh|olti|yetti|sakkiz)';
 const narrative=prose.replace(new RegExp('\\b'+count+'(?:ta)?\\s+(?:ta\\s+)?(?:(?:asosiy|muhim|ustuvor|eng muhim)\\s+)?(?:maslahat|bosqich|tavsiya|qadam)(?:lar)?(?:da|ni|dan)?\\b','giu'),'').replace(/(^|\n)\s*(?:#{1,4}\s+)?(?:\*\*)?\d{1,2}[.)](?:\*\*)?\s/g,'$1').replace(/\bbir\s+(?:nechta|xil|savol|yo‘l|vaqtning o‘zida)\b|\bbir-biridan\b|\bikki xil tushuncha\b/giu,'');
 if(/\p{N}|\b(?:nol|bir|bitta|ikki|ikkita|uch|uchta|to[\u2018\u2019\u02bb\u02bc']rt(?:ta)?|besh(?:ta)?|olti(?:ta)?|yetti(?:ta)?|sakkiz(?:ta)?|to[\u2018\u2019\u02bb\u02bc']qqiz(?:ta)?|o[\u2018\u2019\u02bb\u02bc']n|(?:yigirma|o[\u2018\u2019\u02bb\u02bc']ttiz|qirq|ellik|oltmish|yetmish|sakson|to[\u2018\u2019\u02bb\u02bc']qson)(?:ta|lab|dan|ga|lik)?|(?:yuz|ming|million|milliard)(?:ta|lab|dan|ga|lik)?)\b/iu.test(narrative))throw evidenceError('unsupported_numeric_claim');
 return text.replace(/\{\{([^{}]+)\}\}/g,(_,id)=>known.get(id));
}
export function renderAgentAnswer(reply,toolResults,{evidence=buildAgentEvidence(toolResults)}={}){
 const clarification=toolResults.map(t=>t.result).findLast(r=>r.kind==='clarification');
 if(clarification)return clarification.message;
 if(reply&&typeof reply.reply==='string'){
  const rendered=validateAgentReplyEvidence(reply,evidence);
  return rendered;
 }
 return deterministicAnswer(reply,toolResults);
}

export function renderAgentBlocks(reply,evidence=[]){
 if(reply?.blocks===undefined)return [];
 if(!Array.isArray(reply.blocks)||reply.blocks.length>6)throw evidenceError('invalid_blocks');
 const known=new Map(evidence.map(f=>[f.id,f]));let length=typeof reply.reply==='string'?reply.reply.length:0,ids=0,renderedBytes=0;
 return reply.blocks.map(block=>{
  if(!block||typeof block!=='object'||Array.isArray(block)||Object.keys(block).length!==3||!['paragraph','facts','recommendation'].includes(block.type)||typeof block.text!=='string'||!Array.isArray(block.factIds)||block.factIds.some(id=>typeof id!=='string')||new Set(block.factIds).size!==block.factIds.length)throw evidenceError('invalid_blocks');
  length+=block.text.length;ids+=block.factIds.length;
  if(length>2400||ids>20)throw evidenceError('invalid_blocks');
  if(block.factIds.some(id=>!known.has(id)))throw evidenceError('unknown_anchor');
  const text=validateAgentReplyEvidence({reply:block.text},evidence);
  const facts=block.factIds.map(id=>({id,text:known.get(id).text}));
  renderedBytes+=Buffer.byteLength(text)+facts.reduce((sum,f)=>sum+Buffer.byteLength(f.text),0);
  if(renderedBytes>12000)throw evidenceError('invalid_blocks');
  return {type:block.type,text,facts};
 });
}
