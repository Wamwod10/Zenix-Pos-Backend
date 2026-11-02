import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_AUTOMATED_QUALITY_CASES,assessSyntheticAnswer,summarizeQualityChecks} from '../scripts/aiResponseQuality.mjs';

const grade=(id,answer,status='answered')=>assessSyntheticAnswer({id,answer,status}).status;
test('only selected safe synthetic cases have strict automatic checks',()=>{
 assert.deepEqual(AI_AUTOMATED_QUALITY_CASES,['inventory_1','inventory_2','sales_1','latest_1']);
 assert.equal(grade('comparison_1','The comparison was completed.'),'human_review');
 assert.equal(grade('sales_1',null,'error'),'fail');
});
test('quantity rules distinguish catalog count and low-stock count',()=>{
 assert.equal(grade('inventory_1','Omborda 2 ta faol katalog mahsuloti bor.'),'pass');
 assert.equal(grade('inventory_1','2 ta mahsulot bor, minimumda 0 ta.'),'fail');
 assert.equal(grade('inventory_2','Minimumdan past mahsulot: 0 ta.'),'pass');
 assert.equal(grade('inventory_2','Jami 2 ta, shundan minimumda 0 ta.'),'fail');
});
test('sales amount rules accept Uzbek separators, reject gross/refund clutter',()=>{
 assert.equal(grade('sales_1','Bugungi sof savdo: 100 000 so‘m.'),'pass');
 assert.equal(grade('sales_1','Bugungi sof savdo 100000 soʻm.'),'pass');
 assert.equal(grade('sales_1','Yalpi savdo: 120 000 so‘m.'),'fail');
 assert.equal(grade('sales_1','Sof 100 000 so‘m, yalpi 120 000 so‘m, qaytarish 20 000 so‘m.'),'fail');
 assert.equal(grade('sales_1','Xabar: '+ 'ha '.repeat(150) + '100 000 so‘m'),'fail');
});
test('last sale detects amount and excludes irrelevant raw responses',()=>{
 assert.equal(grade('latest_1','Oxirgi savdo: 69 000 so‘m.'),'pass');
 assert.equal(grade('latest_1','Oxirgi savdo topilmadi.'),'fail');
});
test('aggregate summary never labels heuristic checks as full quality pass',()=>{
 const cases=[
  {quality:assessSyntheticAnswer({id:'sales_1',status:'answered',answer:'100 000 so‘m'})},
  {quality:assessSyntheticAnswer({id:'inventory_1',status:'answered',answer:'Minimumda 0 ta mahsulot bor'})},
  {quality:assessSyntheticAnswer({id:'comparison_1',status:'answered',answer:'Taqqoslash kerak'})},
 ];
 assert.deepEqual(summarizeQualityChecks(cases),{automatedChecks:2,passed:1,failed:1,requiresHumanReview:3,coverage:2/3});
});
