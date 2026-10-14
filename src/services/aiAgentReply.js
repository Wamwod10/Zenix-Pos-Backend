import {HttpError} from '../lib/http.js';

export function assertAgentQuestion(value){
 const text=String(value||'').normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g,'').trim();
 if(!text||text.length>1000||/(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|system\s*prompt|api[_\s-]?key|parol|password|secret|boshqa\s+(?:biznes|tenant|tashkilot)|select\s+.+\s+from|\b(?:drop\s+table|delete\s+from|insert\s+into|update\s+users)\b)/iu.test(text))throw new HttpError(400,'Savol biznes amallari uchun mos emas','AI_UNSAFE_QUESTION');
 return text;
}
export function renderAgentAnswer(reply,toolResults){
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
