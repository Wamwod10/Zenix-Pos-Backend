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
