import test from 'node:test';
import assert from 'node:assert/strict';
import {businessGrowthAdvice} from '../src/services/aiBusinessGrowthAdvice.js';

const fact=(id,value,from='2026-11-02',to='2026-11-08')=>({id,value,label:id,unit:'UZS',from,to});
const report=extra=>({topic:'business_overview',storeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',facts:extra,tables:[],notes:[]});

test('verified 7-day comparison appears in the first concrete recommendation with exact decimal strings',()=>{
 const result=businessGrowthAdvice(report([
  fact('trend_period_current_net','90071992547410.03'),
  fact('trend_period_comparison_net','90071992547409.91','2026-10-26','2026-11-01'),
  fact('trend_period_delta_net','0.12'),
  fact('today_sales_sales_count','0'),
  fact('inventory_warehouse_low_stock_count','2'),
 ]));
 assert.equal(result.answerSource,'verified_fallback');
 assert.match(result.answer,/2026-11-02 — 2026-11-08/);
 assert.match(result.answer,/2026-10-26 — 2026-11-01/);
 assert.match(result.answer,/90 071 992 547 410.03 so‘m/);
 assert.match(result.answer,/90 071 992 547 409.91 so‘m/);
 assert.match(result.answer,/0.12 so‘mga ko‘p/);
 assert.match(result.answer,/qaytarishlar/i);
 assert.doesNotMatch(result.answer,/sof foyda oshgan|bu farq sababni isbotlaydi/i);
});

test('negative growth delta is described as an exact smaller net-sales difference, not a presumed cause',()=>{
 const answer=businessGrowthAdvice(report([
  fact('trend_period_current_net','1000.00'),
  fact('trend_period_comparison_net','1250.00','2026-10-26','2026-11-01'),
  fact('trend_period_delta_net','-250.00'),
 ])).answer;
 assert.match(answer,/250 so‘mga kam/);
 assert.match(answer,/sababini bu farqning o‘zi isbotlamaydi/i);
 assert.doesNotMatch(answer,/250 so‘mga ko‘p|foyda kamaydi/i);
});

test('missing or incomplete trend evidence is not represented as a measured comparison',()=>{
 const incomplete=businessGrowthAdvice(report([fact('trend_period_current_net','1000.00')])).answer;
 assert.match(incomplete,/solishtiring|taqqoslang/i);
 assert.doesNotMatch(incomplete,/joriy davr farqi|avvalgi davrda sof savdo/i);
 const empty=businessGrowthAdvice(null);
 assert.equal(empty.answerSource,'clarification_fallback');
});
