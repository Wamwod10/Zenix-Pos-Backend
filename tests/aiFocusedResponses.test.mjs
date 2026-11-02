import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAgentFallback,buildAgentEvidence,prioritizeVerifiedAnswer} from '../src/services/aiAgentReply.js';
import {createAiAgentProvider} from '../src/services/aiAgentProvider.js';
import {aiSettings} from '../src/config/ai.js';

const fact=(id,value,unit='UZS')=>({id,value,unit,label:id});
const fallback=(report,question)=>{
 const toolResults=[{result:{kind:'report',report}}];
 return safeAgentFallback(buildAgentEvidence(toolResults),toolResults,{question});
};


test('repro: "Bu savdo yaxshi hisoblanadimi?" must never repeat receipt line items',()=>{
 const report={topic:'latest_sale',selection:'by_id',storeId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sale:{total:'4906500.00',businessDate:'2026-10-29',items:[
   {name:'Qaymoq 200ml',quantity:'1',unit:'dona',lineTotal:'13500.00'},
   {name:'Manna yormasi 800g',quantity:'1',unit:'dona',lineTotal:'22000.00'},
   {name:'Nam salfetka 100 dona',quantity:'27',unit:'dona',lineTotal:'931500.00'}],hasMoreItems:true}};
 const answer=fallback(report,'Bu savdo yaxshi hisoblanadimi?');
 assert.equal(answer.answerSource,'verified_fallback');
 assert.match(answer.answer,/4 906 500 so‘m/);
 assert.match(answer.answer,/yaxshi yoki yomon/);
 assert.match(answer.answer,/tannarx|o‘rtacha chek/);
 assert.doesNotMatch(answer.answer,/Qaymoq|Nam salfetka|27 dona|Tanlangan savdo hujjati/);
 const model=prioritizeVerifiedAnswer({
  question:'Bu savdo yaxshi hisoblanadimi?',report,
  toolResults:[{result:{kind:'report',report}}],actions:[],
  answer:'Tanlangan savdo hujjati 4 906 500 so‘m. Qaymoq 200ml ...',
  blocks:[{type:'paragraph',text:'Qolgan mahsulotlar',facts:[]}],
 });
 assert.equal(model.answer,answer.answer);
 assert.deepEqual(model.blocks,[]);
 const noSale=fallback({...report,sale:null},'Bu savdo yaxshi hisoblanadimi?');
 assert.equal(noSale.answerSource,'clarification_fallback');
 assert.doesNotMatch(noSale.answer,/Qaymoq|jami 4 906 500/);
 const unrelated=fallback({topic:'today_sales',facts:[fact('today_net','900000.00')]},'Bu savdo yaxshi hisoblanadimi?');
 assert.equal(unrelated.answerSource,'clarification_fallback');
 assert.doesNotMatch(unrelated.answer,/900 000/);
});

test('latest-sale item question returns verified product names and quantities only',()=>{
 const sale={topic:'latest_sale',selection:'latest',storeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sale:{total:'70000.00',businessDate:'2026-11-02',items:[
   {name:'Non',quantity:'2',unit:'dona',lineTotal:'10000.00'},
   {name:'Sut',quantity:'1',unit:'dona',lineTotal:'60000.00'}],hasMoreItems:false}};
 const got=fallback(sale,'Oxirgi marta nima sotilgan?');
 assert.equal(got.answerSource,'verified_fallback');
 assert.equal(got.answer,'Oxirgi savdoda: Non — 2 dona; Sut — 1 dona (tanlangan filial bo‘yicha).');
 assert.doesNotMatch(got.answer,/70 000|foyda|tavsiya|qarz/);
 const sum=fallback(sale,'Oxirgi savdoda jami qancha sotilgan?');
 assert.equal(sum.answer,'Oxirgi savdo summasi: 70 000 so‘m (tanlangan filial bo‘yicha).');
 const omitted=fallback({...sale,sale:{...sale.sale,items:[...sale.sale.items,{name:'Choy',quantity:'1',unit:'dona'},{name:'Shakar',quantity:'3',unit:'kg'}]}},'Oxirgi marta nima sotilgan?');
 assert.match(omitted.answer,/Qolgan mahsulotlar batafsil ma’lumotlarda/);
 const missing=fallback({...sale,sale:null},'Oxirgi marta nima sotilgan?');
 assert.equal(missing.answer,'Oxirgi savdo topilmadi.');
});
test('short sales question receives only the requested verified net amount',()=>{
 const report={topic:'today_sales',from:'2026-11-01',to:'2026-11-01',facts:[
  fact('sales_count','5','count'),fact('today_gross','2500000.00'),
  fact('today_refunds','50000.00'),fact('today_net','2450000.00'),
 ]};
 const net=fallback(report,'Bugun qancha savdo qildim?');
 assert.equal(net.answerSource,'verified_fallback');
 assert.equal(net.answer,'Bugungi sof savdo: 2 450 000 so‘m.');
 assert.doesNotMatch(net.answer,/qaytarish|yalpi|5 ta|tavsiya/i);
 assert.equal(fallback(report,'Bugun nechta savdo qildim?').answer,'Bugungi savdolar soni: 5 ta.');
 assert.equal(fallback(report,'Bugungi yalpi savdo qancha?').answer,'Bugungi yalpi savdo: 2 500 000 so‘m.');
 assert.equal(fallback(report,'Bugun qaytarish summasi qancha?').answer,'Bugungi qaytarish summasi: 50 000 so‘m.');
});

test('user-scoped metrics do not claim company-wide totals',()=>{
 const report={topic:'today_sales',sellerScoped:true,from:'2026-11-01',to:'2026-11-01',facts:[fact('today_net','8000.00')]};
 const answer=fallback(report,'Bugun qancha savdo qildim?').answer;
 assert.match(answer,/8 000 so‘m/);
 assert.match(answer,/faqat o‘z savdolaringiz bo‘yicha/);
});

test('wrong reporting period never masquerades as requested day',()=>{
 const report={topic:'expenses',from:'2026-10-25',to:'2026-11-01',facts:[fact('expenses','700000.00')]};
 const weekly=fallback(report,'Xarajatlar jami qancha?').answer;
 assert.match(weekly,/Oxirgi 7 biznes kunidagi xarajatlar: 700 000 so‘m/);
 const today=fallback(report,'Bugungi xarajat qancha?').answer;
 assert.doesNotMatch(today,/Bugungi xarajatlar: 700 000/);
});

test('current debts and low stock are concise and numeric facts stay exact',()=>{
 assert.equal(fallback({topic:'customer_debt',facts:[fact('customer_debt','90071992547410.03')]},'Mijozlarning qarzi qancha?').answer,
  'Mijozlarning joriy qarzi: 90 071 992 547 410.03 so‘m.');
 assert.equal(fallback({topic:'low_stock',facts:[fact('low_stock_count','12','count')]},'Minimumdan past nechta mahsulot bor?').answer,
  'Minimum yoki undan past qoldiqdagi mahsulotlar: 12 ta.');
});

test('top product answer is concise, preserving ties and compatible units',()=>{
 const base={topic:'top_products',facts:[
  {...fact('top_products_0','990.00'),productName:'Guruch 25 kg',qty:'12.000',quantityUnit:'dona'},
  {...fact('top_products_1','1100.00'),productName:'Choy',qty:'8.000',quantityUnit:'dona'},
 ]};
 const winner=fallback(base,'Eng ko‘p qaysi mahsulot sotildi?').answer;
 assert.match(winner,/Guruch 25 kg — 12 dona/);
 assert.doesNotMatch(winner,/Choy|990 so‘m|1100 so‘m/);
 const tied=fallback({...base,facts:[base.facts[0],{...base.facts[1],qty:'12'}]},'Eng ko‘p qaysi mahsulot sotildi?').answer;
 assert.match(tied,/teng yetakchilar/);
 assert.match(tied,/Guruch 25 kg, Choy/);
 const mixed=fallback({...base,facts:[base.facts[0],{...base.facts[1],quantityUnit:'kg'}]},'Eng ko‘p qaysi mahsulot sotildi?').answer;
 assert.match(mixed,/bevosita solishtirib bo‘lmaydi/);
});

test('overview fallback chooses one asked sales metric, not the other sections',()=>{
 const overview={topic:'business_overview',from:'2026-10-26',to:'2026-11-01',facts:[
  fact('today_sales_today_net','190000.00'),fact('today_sales_sales_count','3','count'),
  fact('supplier_debt_supplier_debt','700000.00'),fact('expenses_expenses','80000.00'),
 ]};
 const amount=fallback(overview,'Bugun qancha savdo qildim?').answer;
 assert.equal(amount,'Bugungi sof savdo: 190 000 so‘m.');
 assert.doesNotMatch(amount,/qarz|xarajat|700 000/);
 assert.equal(fallback(overview,'Bugun nechta savdo bo‘ldi?').answer,'Bugungi savdolar soni: 3 ta.');
});

test('a question requiring reasons is not reduced to a misleading sale amount',()=>{
 const report={topic:'today_sales',facts:[fact('today_net','2000.00')]};
 const reply=fallback(report,'Nega savdo ko‘paygan?').answer;
 assert.doesNotMatch(reply,/^Bugungi sof savdo: 2 000 so‘m/);
 assert.match(reply,/o‘zi sababni ko‘rsatmaydi/);
 assert.doesNotMatch(reply,/2 000 so‘m/);
});


test('recovery never substitutes the wrong reporting period or ranking metric',()=>{
 const today={topic:'today_sales',facts:[fact('today_net','3000.00'),fact('today_gross','3100.00')]};
 const yesterday=fallback(today,'Kecha qancha savdo bo‘ldi?');
 assert.equal(yesterday.answerSource,'clarification_fallback');
 assert.match(yesterday.answer,/faqat bugungi savdoga/);
 assert.doesNotMatch(yesterday.answer,/3 000|3 100/);
 const expenses={topic:'expenses',facts:[fact('expenses','78000.00')]};
 const perDay=fallback(expenses,'Bugungi xarajat qancha?');
 assert.equal(perDay.answerSource,'clarification_fallback');
 assert.match(perDay.answer,/7 biznes kunini/);
 assert.doesNotMatch(perDay.answer,/78 000/);
 const ranking={topic:'top_products',facts:[{...fact('top_products_0','9000.00'),productName:'Guruch',qty:'12',quantityUnit:'kg'}]};
 const byRevenue=fallback(ranking,'Eng ko‘p daromad keltirgan mahsulot qaysi?');
 assert.equal(byRevenue.answerSource,'clarification_fallback');
 assert.match(byRevenue.answer,/miqdor bo‘yicha/);
 assert.doesNotMatch(byRevenue.answer,/Guruch.*eng ko‘p/);
});

test('successful model reply cannot overwhelm short metric request with unrelated verified sections',()=>{
 const report={topic:'today_sales',from:'2026-11-01',to:'2026-11-01',facts:[
  fact('today_net','2450000.00'),fact('today_gross','2500000.00'),fact('sales_count','5','count'),fact('today_refunds','50000.00'),
 ]};
 const presentation=prioritizeVerifiedAnswer({
  question:'Bugun qancha savdo qildim?',report,toolResults:[{result:{kind:'report',report}}],
  answer:'Bugun sof savdo va qaytarishlar bo‘yicha uzun tahlil...',blocks:[{type:'facts',text:'Ortiqcha statistika',facts:[{id:'extra',text:'Qarz 9000'}]}],actions:[],
 });
 assert.deepEqual(presentation,{answer:'Bugungi sof savdo: 2 450 000 so‘m.',blocks:[]});
});

test('short-answers never change action confirmations, causal questions or unrelated topics',()=>{
 const report={topic:'today_sales',facts:[fact('today_net','2000.00'),fact('sales_count','4','count')]};
 const verbose={answer:'Asl savolga izoh.',blocks:[{type:'paragraph',text:'Batafsil',facts:[]}]};
 const tools=[{result:{kind:'report',report}}];
 for(const question of ['Nega savdo ko‘paydi?','Bugun qancha mahsulot sotdim?','Oxirgi savdo qancha?','Kechagi savdo qancha?','Bugun qancha foyda oldim?','Bugungi savdoni tushuntir']) {
  assert.deepEqual(prioritizeVerifiedAnswer({question,report,toolResults:tools,actions:[],...verbose}),verbose,question);
 }
 assert.deepEqual(prioritizeVerifiedAnswer({question:'Bugun qancha savdo bo‘ldi?',report,toolResults:tools,actions:[{type:'stock_receipt'}],...verbose}),verbose);
 assert.deepEqual(prioritizeVerifiedAnswer({question:'Bugun qancha savdo bo‘ldi?',report,toolResults:[...tools,{result:{kind:'clarification',message:'Birini tanlang'}}],actions:[],...verbose}),verbose);
 assert.deepEqual(prioritizeVerifiedAnswer({question:'Bugun qancha savdo bo‘ldi?',report:null,toolResults:[],actions:[],...verbose}),verbose);
});

test('detailed user requests retain AI reasoning and optional report blocks',()=>{
 const report={topic:'today_sales',facts:[fact('today_net','1234.56')]};
 const full={answer:'Batafsil tahlil:',blocks:[{type:'paragraph',text:'Raqamlar izohi',facts:[]}]};
 assert.deepEqual(prioritizeVerifiedAnswer({question:'Bugungi savdoni batafsil tahlil qilib ber',report,toolResults:[{result:{kind:'report',report}}],actions:[],...full}),full);
});

test('overview gross and refunds never get mislabeled as net sales',()=>{
 const overview={topic:'business_overview',facts:[
  fact('today_sales_today_net','2450000.00'),fact('today_sales_today_gross','2500000.00'),
  fact('today_sales_today_refunds','50000.00'),fact('today_sales_sales_count','5','count')]};
 const reported=(question)=>fallback(overview,question).answer;
 assert.equal(reported('Bugungi yalpi savdo qancha?'),'Bugungi yalpi savdo: 2 500 000 so‘m.');
 assert.equal(reported('Bugun qaytarish summasi qancha?'),'Bugungi qaytarish summasi: 50 000 so‘m.');
 assert.equal(reported('Bugun nechta savdo bo‘ldi?'),'Bugungi savdolar soni: 5 ta.');
 assert.equal(reported('Bugun qancha savdo qildim?'),'Bugungi sof savdo: 2 450 000 so‘m.');
});
test('stock/fallback must not substitute low-stock count for total catalog count',()=>{
 const lowStock={topic:'low_stock',facts:[fact('low_stock_count','3','count')]};
 assert.equal(fallback(lowStock,'Minimumdan past nechta mahsulot bor?').answer,
  'Minimum yoki undan past qoldiqdagi mahsulotlar: 3 ta.');
 assert.doesNotMatch(fallback(lowStock,'Omborda jami nechta mahsulot bor?').answer,/^Minimum yoki undan past qoldiqdagi mahsulotlar: 3 ta/);
 const dormant={topic:'dormant',facts:[fact('dormant_count','7','count')]};
 assert.equal(fallback(dormant,'Sotilmagan mahsulotlar soni nechta?').answer,
  'Oxirgi 30 biznes kunida sotilmagan qoldiqli mahsulotlar: 7 ta.');
 assert.doesNotMatch(fallback(dormant,'Jami mahsulotlar soni nechta?').answer,/^Oxirgi 30 biznes kunida sotilmagan/);
});
test('refund count is not replaced with overall sales count',()=>{
 const report={topic:'today_sales',facts:[fact('sales_count','21','count'),fact('today_refunds','5000.00')]};
 assert.doesNotMatch(fallback(report,'Bugun nechta qaytarish bo‘ldi?').answer,/^Bugungi savdolar soni: 21 ta/);
});
test('Cyrillic and short same-day followups produce only the requested verified metric',()=>{
 const report={topic:'today_sales',from:'2026-11-02',to:'2026-11-02',facts:[
  fact('today_net','250000.00'),fact('today_gross','300000.00'),
  fact('today_refunds','50000.00'),fact('sales_count','8','count'),
 ]};
 assert.equal(fallback(report,'Бугун қанча савдо бўлди?').answer,'Bugungi sof savdo: 250 000 so‘m.');
 assert.equal(fallback(report,'Yalpisi-chi?').answer,'Bugungi yalpi savdo: 300 000 so‘m.');
 assert.equal(fallback(report,'Qaytarishlar-chi?').answer,'Bugungi qaytarish summasi: 50 000 so‘m.');
 assert.equal(fallback(report,'Нечта чек-чи?').answer,'Bugungi savdolar soni: 8 ta.');
 assert.equal(fallback(report,'Sof savdosi-chi?').answer,'Bugungi sof savdo: 250 000 so‘m.');
 const present=prioritizeVerifiedAnswer({question:'Yalpisi-chi?',report,
  toolResults:[{result:{kind:'report',report}}],actions:[],
  answer:'Juda uzun hisobot...',blocks:[{type:'paragraph',text:'Keraksiz',facts:[]}]});
 assert.deepEqual(present,{answer:'Bugungi yalpi savdo: 300 000 so‘m.',blocks:[]});
});
test('cause and historical requests are not silently rewritten as same-day metric followups',()=>{
 const report={topic:'today_sales',from:'2026-11-02',to:'2026-11-02',facts:[fact('today_net','45000.00')]};
 const original={answer:'Farqni tekshirish kerak.',blocks:[{type:'paragraph',text:'Izoh',facts:[]}]};
 for(const question of ['Nega?', 'Kecha qancha edi?', 'Sotuvni batafsil tahlil qilib ber']){
  assert.deepEqual(prioritizeVerifiedAnswer({question,report,toolResults:[{result:{kind:'report',report}}],actions:[],...original}),original,question);
 }
});
test('unrelated metrics are not dumped if the model cannot give a focused answer',()=>{
 const report={topic:'low_stock',from:'2026-11-02',to:'2026-11-02',facts:[
  fact('low_stock_count','3','count'),fact('warehouse_available_products','120','count')]};
 const answer=fallback(report,'Omborda jami nechta mahsulot bor?');
 assert.equal(answer.answerSource,'clarification_fallback');
 assert.match(answer.answer,/so‘ralgan ko‘rsatkichni/);
 assert.doesNotMatch(answer.answer,/120|3 ta|Hisobot davri/);
 const detailed=fallback(report,'Ombor haqida batafsil tahlil ber');
 assert.notEqual(detailed.answerSource,'clarification_fallback');
});

test('provider instructs answer-first, minimum relevant detail and verified anchors',async()=>{
 const settings={...aiSettings(),enabled:true,apiKey:'test-only'};
 let inspected=false;
 const mocked=async(_url,{body})=>{
  const {input}=JSON.parse(body),instructions=input[0].content;
  assert.match(instructions,/ANSWER THE LAST QUESTION FIRST/);
  assert.match(instructions,/ONLY the requested verified fact/);
  assert.match(instructions,/For simple answers use blocks \[\]/);
  assert.match(instructions,/server \{\{id\}\} anchors or block factIds only/);
  assert.match(instructions,/do not invent causes/i);
  inspected=true;
  return Response.json({status:'completed',usage:{input_tokens:140,output_tokens:20},
   output:[{type:'message',role:'assistant',status:'completed',
    content:[{type:'output_text',text:JSON.stringify({kind:'greeting',reply:'Salom!',blocks:[]})}]}]});
 };
 const provider=createAiAgentProvider(settings,mocked);
 const result=await provider([{role:'user',content:'Salom'}],{tools:[],onDispatch:async()=>{}});
 assert.equal(inspected,true);
 assert.equal(result.reply.reply,'Salom!');
});
