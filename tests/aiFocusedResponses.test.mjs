import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAgentFallback,buildAgentEvidence} from '../src/services/aiAgentReply.js';
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

test('a question requiring reasons is not reduced to a misleading sale amount',()=>{
 const report={topic:'today_sales',facts:[fact('today_net','2000.00')]};
 const reply=fallback(report,'Nega savdo ko‘paygan?').answer;
 assert.doesNotMatch(reply,/^Bugungi sof savdo: 2 000 so‘m/);
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
