import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentEvidence,renderAgentAnswer} from '../src/services/aiAgentReply.js';
test('evidence anchors preserve context and natural reply',()=>{
 const tools=[{result:{kind:'stock',productName:'Guruch',unit:'kg',locations:[{warehouseName:'Asosiy',quantity:'3.000'}]}}];
 const evidence=buildAgentEvidence(tools);
 assert.deepEqual(buildAgentEvidence(tools),evidence);
 const reply={kind:'results',reply:`Qoldiqni tekshirdim:\n{{${evidence[0].id}}}\nYana qaysi omborni tekshiramiz?`};
 assert.match(renderAgentAnswer(reply,tools),/Qoldiqni tekshirdim:/);
 assert.match(renderAgentAnswer(reply,tools),/Guruch.*Asosiy.*3.000 kg/s);
 assert.throws(()=>renderAgentAnswer({kind:'results',reply:'{{f_unknown}}'},tools),e=>e.code==='AI_EVIDENCE_INVALID');
});
test('general numeric advice can remain natural',()=>{
 assert.equal(renderAgentAnswer({kind:'advice',reply:'Umumiy tavsiya: 3 bosqichda tekshiring: savdo, xarajat va qoldiq.'},[]),'Umumiy tavsiya: 3 bosqichda tekshiring: savdo, xarajat va qoldiq.');
});
test('numbered advice is not a bypass for invented business quantities',()=>{
 for(const reply of ['100 ta mahsulot bor.','Qoldiq oltita.','3 maslahat: savdo 100000.','Mahsulotlar nol dona.','Ellikta mahsulot mavjud.','O’ttizta mahsulot mavjud.'])assert.throws(()=>renderAgentAnswer({kind:'advice',reply},[]),e=>e.code==='AI_EVIDENCE_INVALID');
 assert.equal(renderAgentAnswer({kind:'advice',reply:'1. Hisobotlarni tekshiring.\n2. Xarajatlarni toifalang.'},[]),'1. Hisobotlarni tekshiring.\n2. Xarajatlarni toifalang.');
});
test('normal possessive explanations and conceptual follow-up questions stay natural',()=>{
 for(const reply of ['Savdongizni tahlil qilishni xohlaysizmi?','Nega kamaydi? Buni tekshirish uchun davrni aniqlashtiraylik.','Foydangizni oshirish uchun avval xarajat toifalarini tekshiring.'])assert.equal(renderAgentAnswer({kind:'advice',reply},[]),reply);
});
test('reviewed unsupported personalized claims and reframed facts fail closed',()=>{
 for(const reply of ['Eng ko‘p sotiladigan mahsulotingiz Pepsi.','Foydangiz zarar bilan yakunlangan.','Mingta mahsulot mavjud.','Bu zarar ko‘rsatkichi.'])assert.throws(()=>renderAgentAnswer({kind:'advice',reply},[]),e=>e.code==='AI_EVIDENCE_INVALID');
});
test('comparison evidence labels the actual comparison period and long location lists retain bounded rows',()=>{
 const report={from:'2026-10-01',to:'2026-10-07',comparisonFrom:'2026-09-24',comparisonTo:'2026-09-30',facts:[{id:'period_comparison_net',label:'Taqqoslash davri sof savdosi',value:'80000',unit:'UZS',from:'2026-09-24',to:'2026-09-30'}],notes:[],tables:[]};
 const evidence=buildAgentEvidence([{result:{kind:'report',report}}]);assert.match(evidence[0].text,/Hisobot davri: 2026-09-24 - 2026-09-30/);assert.ok(!evidence[0].text.includes('2026-10-01'));
 const stock=buildAgentEvidence([{result:{kind:'stock',productName:'Guruch',unit:'kg',locations:Array.from({length:50},(_,i)=>({storeName:'Filial '+i,warehouseName:'Ombor '.repeat(12),quantity:'10'}))}}]);
 assert.ok(stock.length>1&&stock.length<=20);assert.ok(stock.every(e=>e.text.includes('Guruch')&&e.text.includes('10 kg')));assert.ok(stock.reduce((n,e)=>n+Buffer.byteLength(e.text)+e.id.length,0)<=4000);
});

const natural=[
 'Salom! Qanday yordam beraman?', 'Assalomu alaykum! Savolingizni yozing.', 'Qaysi omborni tekshiramiz?',
 'Qaysi mahsulot haqida gaplashamiz?', 'Qaysi davr kerak?', 'Aniqroq nomini ayting.', 'Filialni tanlang.',
 'Sababini aytish uchun tarixiy ma’lumot kerak.', 'Jami mahsulotlar va minimumdagi mahsulotlar boshqa ko‘rsatkichlar.',
 'Bu ko‘rsatkichlarni alohida tahlil qilish kerak.', 'Ma’lumot mavjud emas.', 'Natijalarni birgalikda ko‘rib chiqamiz.',
 'Qoldiq haqida yana savolingiz bormi?', 'Savdo va qoldiq tushunchalari farq qiladi.', 'Taqqoslash uchun davrlarni belgilang.',
 'Umumiy tavsiya: hisobotlarni muntazam tekshiring.', 'Umumiy tavsiya: 3 bosqichda tekshiring.', '2 maslahat: hisobotni oching va davrni tanlang.',
 'Xarajatlarni toifalar bo‘yicha tekshiring.', 'Tarixiy natija kelajakni kafolatlamaydi.', 'Shartlar teng bo‘lsa, davrlarni taqqoslang.',
 'Agar xarajatlar o‘zgarsa, sabablarni alohida tekshiring.', 'Mahsulot nomini aniqlashtiring.', 'Ombor nomini yozing.',
 'Hisobot davri kerak.', 'Maqsadingizni aniqlashtiraylik.', 'Qaysi hisobotni ochamiz?', 'Avval savdoni tekshirish mumkin.',
 'Keyin xarajatlarni ko‘rib chiqing.', 'Qaysi jihatini tushuntiray?'
];
for(const [i,reply] of natural.entries())test('natural Uzbek prose '+i,()=>{
 assert.equal(renderAgentAnswer({kind:'advice',reply},[]),reply.normalize('NFKC'));
});
