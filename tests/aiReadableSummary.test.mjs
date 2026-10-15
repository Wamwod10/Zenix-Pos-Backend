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
