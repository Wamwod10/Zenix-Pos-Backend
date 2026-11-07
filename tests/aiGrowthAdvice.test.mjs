import test from 'node:test';
import assert from 'node:assert/strict';
import {isBusinessGrowthAdviceQuestion} from '../src/services/aiQuestionRouting.js';
import {businessGrowthAdvice} from '../src/services/aiBusinessGrowthAdvice.js';
import {safeAgentFallback,buildAgentEvidence,prioritizeVerifiedAnswer,isBusinessImprovementQuestion} from '../src/services/aiAgentReply.js';
const fact=(id,value,label=id,unit='UZS',extra={})=>({id,value,label,unit,...extra});
const report=(facts,storeId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')=>({topic:'business_overview',storeId,facts,tables:[],notes:[]});
const screenshot=()=>report([
 fact('today_sales_sales_count','0','Bugungi savdolar soni','count'),
 fact('today_sales_today_net','0.00'),
 fact('inventory_warehouse_available_products','103','Available','count'),
 fact('inventory_warehouse_low_stock_count','2','Minimum','count'),
 fact('customer_debt_customer_debt','150000.00'),
 fact('supplier_debt_supplier_debt','0.00'),
 fact('expenses_expenses','0.00'),
 fact('profit_profit_0','404000.00','Keks 250g: foyda','UZS',{productName:'Keks 250g'}),
 fact('profit_profit_1','325000.00','Tish cho‘tkasi: foyda','UZS',{productName:'Tish cho‘tkasi'}),
 fact('profit_profit_2','216000.00','Nam salfetka: foyda','UZS',{productName:'Nam salfetka'}),
]);
test('common natural growth questions are recognized, including the exact complaint and Cyrillic',()=>{
 for(const question of [
  'Nimalar qilsam biznesim rivojlanadi?',
  'Biznesimni qanday yaxshilasam bo‘ladi?',
  'Бизнесимни қандай ривожлантираман?',
  'Savdolarni oshirish uchun qanday usullar bor?',
  'Mijozlarni ko‘paytirish uchun nima qilay?',
  'Biznesim rivojlanishi uchun maslahat ber',
 ]) {
  assert.equal(isBusinessGrowthAdviceQuestion(question),true,question);
  assert.equal(isBusinessImprovementQuestion(question),true,question);
 }
 for(const q of ['Bugun savdo bo‘ldimi?','Kechagi savdoni hisobla',
  'Nega savdo kamaydi?','Biznesning xarajat hisobotini chiqar',
  'Savdoni kechagi bilan solishtir','Mijoz qarzini o‘chir']){
  assert.equal(isBusinessGrowthAdviceQuestion(q),false,q);
 }
});
test('screenshot numbers become actionable growth priorities, not raw report or zero-payable advice',()=>{
 const value=businessGrowthAdvice(screenshot());
 assert.equal(value.answerSource,'verified_fallback');
 assert.match(value.answer,/Bugun tanlangan filial bo‘yicha savdo qayd etilmagan/);
 assert.match(value.answer,/Keks 250g/);
 assert.match(value.answer,/Tish cho‘tkasi/);
 assert.match(value.answer,/2 ta minimum/);
 assert.match(value.answer,/7–30/);
 assert.match(value.answer,/1\. /);
 assert.match(value.answer,/2\. /);
 assert.match(value.answer,/3\. /);
 assert.doesNotMatch(value.answer,/to‘lanadigan 0|ta’minotchi hujjatlaridagi to‘lov muddatlari/);
 assert.doesNotMatch(value.answer,/hisobotlardan tayyorlangan qisqa xulosa|xarajat yozuvlari \(2026/);
 assert.doesNotMatch(value.answer,/sof foyda 404 000|talab oshgan|foydangiz oshadi/iu);
 assert.ok(value.answer.length<2400);
});
test('when neither sales nor product-profit data exists, advice avoids false specificity',()=>{
 const result=businessGrowthAdvice(null);
 assert.equal(result.answerSource,'clarification_fallback');
 assert.match(result.answer,/tannarx|savdo/);
 assert.doesNotMatch(result.answer,/Bugun .* savdo qayd etilmagan|qarz|0 so‘m/);
});
test('positive payables only become a priority when backed by a positive debt',()=>{
 const withDebt=report([
  fact('supplier_debt_supplier_debt','90071992547410.03'),
  fact('inventory_warehouse_low_stock_count','2','Low','count')]);
 const advice=businessGrowthAdvice(withDebt).answer;
 assert.match(advice,/90 071 992 547 410.03 so‘mlik qarz/);
 assert.match(advice,/tasdiqsiz kirim qilmang/);
 assert.doesNotMatch(advice,/to‘lanadigan 0/);
});
test('scope and zero-sales nuance survive: one-day zero is not proof demand collapsed',()=>{
 const seller=report([fact('today_sales_sales_count','0','Count','count')],null);
 seller.sellerScoped=true;
 const text=businessGrowthAdvice(seller).answer;
 assert.match(text,/sizga ruxsat etilgan savdolar/);
 assert.match(text,/bitta kun sabab yoki trendni isbotlamaydi/);
 assert.doesNotMatch(text,/filialda talab yo‘q|savdo kamaygan/);
});
test('recovery uses growth advice, not repeated overview lines',()=>{
 const r=screenshot(),tools=[{result:{kind:'report',report:r}}];
 const recovery=safeAgentFallback(buildAgentEvidence(tools),tools,{question:'Nimalar qilsam biznesim rivojlanadi?'});
 assert.equal(recovery.answerSource,'verified_fallback');
 assert.match(recovery.answer,/Keks 250g/);
 assert.doesNotMatch(recovery.answer,/Ta’minotchi hujjatlaridagi to‘lov muddatlarini tekshiring/);
});
test('successful model report dump gets replaced; substantiated model plan remains',()=>{
 const r=screenshot(),toolResults=[{result:{kind:'report',report:r}}];
 const verbose='Tanlangan filial bo‘yicha hisobotlardan tayyorlangan qisqa xulosa: qoldiqning joriy holati...';
 const presentation=prioritizeVerifiedAnswer({
  question:'Nimalar qilsam biznesim rivojlanadi?',report:r,toolResults,actions:[],
  answer:verbose,blocks:[{type:'facts',text:'Qarz: 0',facts:[]}],
 });
 assert.match(presentation.answer,/1\. Savdoni/);
 assert.deepEqual(presentation.blocks,[]);
 const valid=prioritizeVerifiedAnswer({
  question:'Biznesimni qanday yaxshilasam bo‘ladi?',report:r,toolResults,actions:[],
  answer:'Avval solishtirish uchun bir xil davrdagi ko‘rsatkichlarni oling.',
  blocks:[{type:'recommendation',text:'Savdolarni solishtiring.',facts:[]},{type:'recommendation',text:'Qoldiqni tekshiring.',facts:[]}],
 });
 assert.equal(valid.answer,'Avval solishtirish uchun bir xil davrdagi ko‘rsatkichlarni oling.');
 assert.equal(valid.blocks.length,2);
 const misplaced=prioritizeVerifiedAnswer({
  question:'Biznesimni qanday yaxshilasam bo‘ladi?',report:r,toolResults,actions:[],
  answer:'Ta’minotchilar qarzini birinchi to‘lang.',
  blocks:[{type:'recommendation',text:'Ta’minotchi qarzini tekshiring.',facts:[]},{type:'recommendation',text:'Savdoni solishtiring.',facts:[]}],
 });
 assert.doesNotMatch(misplaced.answer,/Ta’minotchilar qarzini birinchi/);
});


test('practical colloquial growth questions are classified without routing causes or writes',()=>{
 for(const q of ['Savdom yurishmayapti, qanday yaxshilayman?', 'Mijoz jalb qilish uchun nima qilay?', 'Savdo sust, qanday maslahat berasan?']){
  assert.equal(isBusinessGrowthAdviceQuestion(q),true,q);
 }
 for(const q of ['Nega savdo sust?', 'Mijoz qarzini o‘chir', 'Savdo tarixini batafsil hisobot qil']){
  assert.equal(isBusinessGrowthAdviceQuestion(q),false,q);
 }
});
test('useful verified numbered model plan is preserved without recommendation blocks',()=>{
 const r=screenshot(),toolResults=[{result:{kind:'report',report:r}}];
 const answer='Biznesni yaxshilash uchun:\n1. Savdo davrlarini solishtiring va o‘zgarishni tekshiring.\n2. Ombor qoldig‘ini nazorat qiling, yetishmayotgan mahsulotlarni aniqlang.\n3. Mijozlar qarzini tekshiring va to‘lov rejasini tuzing.';
 const result=prioritizeVerifiedAnswer({question:'Biznesimni qanday rivojlantirsam bo‘ladi?',report:r,toolResults,actions:[],answer,blocks:[]});
 assert.equal(result.answer,answer);
 assert.deepEqual(result.blocks,[]);
});
test('generic recommendation headings are not considered a useful growth plan',()=>{
 const r=screenshot(),toolResults=[{result:{kind:'report',report:r}}];
 const weak=prioritizeVerifiedAnswer({question:'Biznesimni qanday yaxshilasam bo‘ladi?',report:r,toolResults,actions:[],
  answer:'Umumiy tavsiyalar',blocks:[{type:'recommendation',text:'Biznesni yaxshi yuriting.',facts:[]},{type:'recommendation',text:'Ko‘proq harakat qiling.',facts:[]}]});
 assert.match(weak.answer,/Savdoni|sotilish|qoldiq|qarz/iu);
 assert.deepEqual(weak.blocks,[]);
});
