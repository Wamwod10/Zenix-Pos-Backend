import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAgentFallback,buildAgentEvidence} from '../src/services/aiAgentReply.js';
const fact=(id,value,unit='UZS',label=id)=>({id,value,unit,label,from:'2026-10-15',to:'2026-10-15'});
const overview={topic:'business_overview',storeId:'synthetic-store',from:'2026-10-09',to:'2026-10-15',facts:[
 fact('today_sales_today_net','0.00'),fact('today_sales_sales_count','0','count'),
 fact('inventory_warehouse_catalog_products','40','count'),fact('inventory_warehouse_available_products','40','count'),fact('inventory_warehouse_low_stock_count','0','count'),
 fact('customer_debt_customer_debt','12000.00'),fact('supplier_debt_supplier_debt','840000.00'),
 {...fact('expenses_expenses','0.00'),from:'2026-10-09'},
 {...fact('profit_profit_0','1200.00','UZS','Guruch foydasi'),from:'2026-10-09'},
 ],notes:['Joriy ombor holati haftalik savdo emas.'],tables:[]};
const tools=[{result:{kind:'report',report:overview}}];

test('latest read determines fallback instead of an earlier unrelated overview',()=>{
 const results=[...tools,{result:{kind:'report',report:{topic:'latest_sale',sale:null,facts:[],tables:[],notes:[]}}}];
 const answer=safeAgentFallback(buildAgentEvidence(results),results).answer;
 assert.match(answer,/savdo topilmadi/);assert.doesNotMatch(answer,/qisqa xulosa/);
});

test('generic fallback only includes facts from the final report',()=>{
 const results=[...tools,{result:{kind:'report',report:{topic:'get_warehouse_summary',facts:[fact('warehouse','12','count','Ombor mahsulotlari')],tables:[],notes:[]}}}];
 const answer=safeAgentFallback(buildAgentEvidence(results),results).answer;
 assert.match(answer,/Ombor mahsulotlari: 12 ta/);assert.doesNotMatch(answer,/Bugun|Joriy qarzlar/);
});
test('verified overview fallback is a concise readable summary, not an evidence dump',()=>{
 const response=safeAgentFallback(buildAgentEvidence(tools),tools);
 assert.equal(response.answerSource,'verified_fallback');assert.ok(response.answer.length<1800);
 assert.match(response.answer,/Bugun/);assert.match(response.answer,/0 so‘m/);assert.match(response.answer,/840 000 so‘m/);
 assert.match(response.answer,/xarajat yozuvlari/i);assert.match(response.answer,/jami sof foydasi emas/i);
 assert.ok(!response.answer.includes('Hisobot davri:'));assert.ok(!response.answer.includes('AI izohini tekshirish yakunlanmadi'));
});
test('missing or restricted overview topics never become invented zero metrics',()=>{
 const limited=[{result:{kind:'report',report:{...overview,facts:[fact('today_sales_today_net','250.50')],notes:[]}}}];
 const response=safeAgentFallback(buildAgentEvidence(limited),limited);
 assert.match(response.answer,/250.50 so‘m/);assert.ok(!/qarz|Qoldiq|(?<![\d.])0 so‘m|Guruch/.test(response.answer));
});
test('mixed-period overview caveats do not inherit a false weekly inventory period',()=>{
 const [note]=buildAgentEvidence(tools);assert.ok(note.text.includes('Tanlangan filial'));assert.ok(!note.text.includes('2026-10-09'));
});
test('large decimal amounts stay exact and unknown historical profit never becomes zero',()=>{
 const limited=[{result:{kind:'report',report:{...overview,facts:[fact('supplier_debt_supplier_debt','90071992547410.03'),fact('profit_profit_0',null)],notes:[]}}}];
 const response=safeAgentFallback(buildAgentEvidence(limited),limited);
 assert.match(response.answer,/90 071 992 547 410.03 so‘m/);assert.match(response.answer,/tannarxi yetarli emas/);assert.ok(!response.answer.includes('0 so‘m'));
});
test('seller-only sales are explicitly identified in the visible summary',()=>{
 const scoped=[{result:{kind:'report',report:{...overview,sellerScoped:true}}}];
 assert.match(safeAgentFallback(buildAgentEvidence(scoped),scoped).answer,/faqat o‘z savdolaringiz/);
});

const summaryOf=report=>{const results=[{result:{kind:'report',report}}];return safeAgentFallback(buildAgentEvidence(results),results).answer};
const ranking={topic:'top_products',from:'2026-10-09',to:'2026-10-15',facts:[
 {...fact('top_products_0','900.00'),productName:'Guruch 25 kg',qty:'12.000',quantityUnit:'dona',metric:'revenue'},
 {...fact('top_products_1','1200.00'),productName:'Choy',qty:'12',quantityUnit:'dona',metric:'revenue'},
],tables:[],notes:[]};
test('top product fallback names tied quantity leaders and separates revenue',()=>{
 const answer=summaryOf(ranking);
 assert.match(answer,/Guruch 25 kg/);assert.match(answer,/Choy/);assert.match(answer,/teng/i);
 assert.match(answer,/12 dona/);assert.match(answer,/900 so‘m/);assert.match(answer,/Sof savdo/);
 assert.equal(answer.split('2026-10-09').length-1,1);assert.doesNotMatch(answer,/eng ko‘p daromad/);
});
test('empty rankings explicitly report no data without inventing a winner',()=>{
 assert.match(summaryOf({...ranking,facts:[]}),/savdo ma’lumoti topilmadi/);
});
test('latest sale fallback shows actual sale date, sold units and total',()=>{
 const answer=summaryOf({topic:'latest_sale',sale:{businessDate:'2026-10-14',createdAt:'2026-10-14T10:11:00Z',total:'700.00',returnedAmount:'0.00',items:[{name:'Choy 20 dona',quantity:'2.000',unit:'quti',unitPrice:'350.00',lineTotal:'700.00'}]},facts:[],notes:[],tables:[]});
 assert.match(answer,/Oxirgi savdo/);assert.match(answer,/2026-10-14/);assert.match(answer,/Choy 20 dona: 2 quti/);assert.match(answer,/700 so‘m/);assert.doesNotMatch(answer,/Bugun|40 quti/);
 assert.match(summaryOf({topic:'latest_sale',sale:null,facts:[],tables:[],notes:[]}),/savdo topilmadi/);
});
test('ranking summary remains anchored evidence with exact large monetary values',()=>{
 const report={...ranking,sellerScoped:true,facts:[{...ranking.facts[0],value:'90071992547410.03'}]};
 const results=[{result:{kind:'report',report}}],evidence=buildAgentEvidence(results);
 assert.match(evidence[0].text,/Guruch 25 kg/);assert.match(evidence[0].text,/90 071 992 547 410.03/);
 assert.match(evidence[0].text,/faqat o‘z savdolaringiz/);
});
test('different quantity units carry a comparison caveat',()=>{
 const answer=summaryOf({...ranking,facts:[ranking.facts[0],{...ranking.facts[1],quantityUnit:'kg'}]});
 assert.match(answer,/bevosita solishtirib bo‘lmaydi/);assert.doesNotMatch(answer,/teng yetakchilar/);
});
test('exact prior receipt summary never presents it as the latest sale',()=>{
 const report={topic:'latest_sale',selection:'by_id',sale:{businessDate:'2026-10-10',createdAt:'2026-10-10T10:11:00Z',total:'700.00',items:[]},facts:[],notes:[],tables:[]};
 const answer=summaryOf(report);
 assert.match(answer,/Tanlangan savdo hujjati/);assert.doesNotMatch(answer,/Oxirgi savdo/);
 const evidence=buildAgentEvidence([{result:{kind:'report',report}}]);
 assert.match(evidence[0].text,/Tanlangan savdo hujjati/);
});
test('truncated sale fallback clearly states that details are incomplete',()=>{
 const answer=summaryOf({topic:'latest_sale',selection:'latest',sale:{businessDate:'2026-10-14',createdAt:'2026-10-14T10:11:00Z',total:'700.00',hasMoreItems:true,items:Array.from({length:50},()=>({name:'Choy',quantity:'1',unit:'quti',lineTotal:'14'}))},facts:[],notes:[],tables:[]});
 assert.match(answer,/batafsil ma’lumotlar ham to‘liq emas/);assert.match(answer,/Jami summa barcha mahsulotlarni qamrab oladi/);
 assert.doesNotMatch(answer,/Qolgan mahsulotlar batafsil ma’lumotlarda\./);
});
