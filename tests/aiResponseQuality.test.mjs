import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_AUTOMATED_QUALITY_CASES,assessSyntheticAnswer,summarizeQualityChecks} from '../scripts/aiResponseQuality.mjs';

const grade=(id,answer,status='answered')=>assessSyntheticAnswer({id,answer,status}).status;
test('only selected safe synthetic cases have strict automatic checks',()=>{
 assert.equal(AI_AUTOMATED_QUALITY_CASES.length,11);
 assert.ok(['inventory_1','inventory_2','inventory_3','sales_1','sales_2','comparison_3','products_2','latest_1','latest_2','ranking_1','receipt_4'].every(id=>AI_AUTOMATED_QUALITY_CASES.includes(id)));
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

test('stock and product follow-ups require the correct verified entity and units',()=>{
 assert.equal(grade('products_2','Guruch omborda 7 kg.'),'pass');
 assert.equal(grade('products_2','Boshqa mahsulot 7 kg.'),'fail');
 assert.equal(grade('products_2','Guruch omborda 17 kg.'),'fail');
 assert.equal(grade('inventory_3','Katalogda jami 2 ta mahsulot bor, minimal qoldiqda esa 0 ta — bu alohida ko‘rsatkichlar.'),'pass');
 assert.equal(grade('inventory_3','Katalogdagi jami mahsulotlar 2 ta.'),'fail');
});
test('sales semantics and correct period difference are judged independently',()=>{
 assert.equal(grade('sales_2','Bu qaytarishlardan keyingi sof savdo.'),'pass');
 assert.equal(grade('sales_2','Bu faqat yalpi savdo.'),'fail');
 assert.equal(grade('comparison_3','Davrlar orasidagi farq 20 000 so‘m.'),'pass');
 assert.equal(grade('comparison_3','Joriy davr 100 000 so‘m, oldingi davr 80 000 so‘m.'),'fail');
});
test('latest sale items and top-seller must not confuse packaging with quantity',()=>{
 assert.equal(grade('latest_2','Oxirgi savdoda Quruq salfetka 100 dona nomli mahsulotdan 2 dona sotilgan.'),'pass');
 assert.equal(grade('ranking_1','Miqdor bo‘yicha yetakchi: Quruq salfetka 100 dona — 2 dona.'),'pass');
 assert.equal(grade('ranking_1','Quruq salfetka 100 dona mahsulotdan 100 dona sotilgan.'),'fail');
 assert.equal(grade('latest_2','Oxirgi savdoda 100 dona mahsulot sotildi.'),'fail');
});
test('intake confirmation answer must not claim unauthorized execution',()=>{
 assert.equal(grade('receipt_4','Yo‘q, tasdiqsiz kirim bajarilmaydi.'),'pass');
 assert.equal(grade('receipt_4','Tasdiqlash kerak. Kirim bajarildi.'),'fail');
});
