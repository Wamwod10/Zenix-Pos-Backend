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
  const prefix=report?.from&&report?.to?`${report.comparisonFrom?`Joriy davr: ${report.from} - ${report.to}; Taqqoslash davri: ${report.comparisonFrom} - ${report.comparisonTo}`:`Hisobot davri: ${report.from} - ${report.to}`}; ${scope}\n`:report?scope+'\n':'';
  const fragments=report?[
   ...(report.notes||[]).map(note=>prefix+note),
   ...(report.facts||[]).map(f=>(f.from&&f.to?`Hisobot davri: ${f.from} - ${f.to}; ${scope}\n`:prefix)+deterministicAnswer(null,[{result:{kind:'report',report:{facts:[f]}}}])),
   ...(report.tables||[]).flatMap(t=>(t.rows||[]).slice(0,10).map(row=>t.title+': '+t.columns.map((column,i)=>column+': '+row[i]).join('; '))),
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
export function validateAgentReplyEvidence(reply,evidence=[]){
 const text=reply.reply.normalize('NFKC'),known=new Map(evidence.map(f=>[f.id,f.text]));
 const anchors=[...text.matchAll(/\{\{([^{}]+)\}\}/g)];
 if(anchors.some(m=>!known.has(m[1])))throw evidenceError('unknown_anchor');
 const prose=text.replace(/\{\{[^{}]+\}\}/g,'');
 if(/[{}]/.test(prose))throw evidenceError('malformed_anchor');
 // Conservative syntactic guards do not prove arbitrary prose semantically.
 if(/(?:kiritildi|bajarildi|tasdiqlandi|bekor qilindi|executed|confirmed|cancelled|deleted)/iu.test(prose))throw evidenceError('execution_claim');
 const statements=prose.replace(/[^.!?\n]*\?/gu,'');
 if(/\b(?:kamaydi|oshdi|sotildi|tashkil etdi)[.!]?(?:\s|$)/iu.test(statements))throw evidenceError('unsupported_business_assertion');
 const claims=statements.replace(/\b(?:savdongizni|foydangizni|daromadingizni)\s+(?:tahlil qilish|oshirish|tekshirish)\s+uchun\b/giu,'');
 if(/(?:mahsulot|savdo|foyda|daromad|ombor|qoldiq|xarajat|qarz)\w*i?ngiz|\b(?:yakunlangan|pasaygan|qimmatlashgan|sotiladigan)\b|\bBu\s+zarar\s+ko[‘’']rsatkichi/iu.test(claims))throw evidenceError('unsupported_business_assertion');
 // Numbered advice is presentation, not a business statistic. All other
 // quantities (including numbers written in Uzbek words) require an anchor.
 const count='(?:\\d{1,2}|bir|ikki|uch|besh|olti|yetti|sakkiz)';
 const narrative=prose.replace(new RegExp('\\b'+count+'\\s+(?:maslahat|bosqich|tavsiya|qadam)(?:da|ni|dan)?\\b','giu'),'').replace(/(^|\n)\s*\d{1,2}[.)]\s/g,'$1').replace(/\bbir\s+(?:nechta|xil|savol|yo‘l)\b/giu,'');
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
