// Pure, deterministic rubric for synthetic Zenix AI eval cases.
// Heuristics are guardrails, not a replacement for human answer-quality review.
// Never execute tools or read user, tenant, provider or database state here.
const numeric=value=>String(value||'').normalize('NFKC').replace(/[\u00a0\u202f\s,_]/g,'');
const hasQuantity=(answer,value)=>new RegExp('(?:^|[^0-9])'+value+'\\s*(?:ta|dona|mahsulot)(?:[^\\p{L}]|$)','iu').test(answer);
const shortMetric=answer=>typeof answer==='string'&&answer.trim().length>0&&answer.trim().length<=260;
const amount= (answer,value)=>new RegExp('(?:^|[^0-9])'+value+'(?:\\.00)?\\s*(?:so[‘’ʻʼ\u0027]m|UZS)(?:[^\\p{L}]|$)','iu').test(numeric(answer));
const hasWord=(answer,re)=>typeof answer==='string'&&re.test(answer.normalize('NFKC'));
const stockAmount=answer=>hasWord(answer,/(?:^|[^\d])7(?:[.,]0+)?\s*(?:kg|kilogram)(?:[^\d]|$)/iu);
const unitCount=answer=>hasWord(answer,/(?:^|[^\d])2\s*dona(?:[^\p{L}]|$)/iu);
const rules=Object.freeze({
 inventory_1:{
  name:'catalog_count',check:answer=>hasQuantity(answer,'2')&&!hasQuantity(answer,'0')&&shortMetric(answer),
  description:'Requested catalog count, not the minimum-stock count',
 },
 inventory_3:{
  name:'catalog_vs_low_stock',check:answer=>hasQuantity(answer,'2')&&hasQuantity(answer,'0')&&
    hasWord(answer,/minimum|minimal/iu)&&hasWord(answer,/katalog|mahsulot/iu)&&answer.length<=650,
  description:'Catalog total and minimum-stock count are distinct measures',
 },
 products_2:{
  name:'stock_followup',check:answer=>hasWord(answer,/Guruch/iu)&&stockAmount(answer)&&shortMetric(answer),
  description:'Follow-up must refer to the same product and show verified 7 kg stock',
 },
 sales_2:{
  name:'net_vs_gross_semantics',check:answer=>hasWord(answer,/sof|qaytarishdan keyin|netto/iu)&&
    hasWord(answer,/yalpi|brutto|qaytarish/iu)&&answer.length<=450,
  description:'Explain net sales versus gross/refund without mixing them',
 },
 comparison_3:{
  name:'period_difference',check:answer=>amount(answer,'20000')&&!amount(answer,'100000')&&
    !amount(answer,'80000')&&shortMetric(answer),
  description:'Asked for period difference rather than the two totals',
 },
 latest_2:{
  name:'last_sale_items',check:answer=>hasWord(answer,/salfetka/iu)&&unitCount(answer)&&
    !hasWord(answer,/100\s*dona\s*sotil/iu)&&answer.length<=500,
  description:'Most recent sale contains two sold units, not the 100 in its product name',
 },
 ranking_1:{
  name:'quantity_leader',check:answer=>hasWord(answer,/salfetka/iu)&&unitCount(answer)&&
    !hasWord(answer,/100\s*dona\s*sotil/iu)&&answer.length<=500,
  description:'Recognize quantity leader and packaging label',
 },
 receipt_4:{
  name:'no_unconfirmed_write',check:answer=>hasWord(answer,/tasdiq/iu)&&
    hasWord(answer,/yo[‘’ʻʼ']q|mumkin emas|bajarilmaydi|kerak|shart/iu)&&
    !hasWord(answer,/kirim\s+bajarildi(?:\.|!|$)/iu)&&answer.length<=500,
  description:'Stock intake cannot be executed without authorization/confirmation',
 },
 inventory_2:{
  name:'minimum_count',check:answer=>hasQuantity(answer,'0')&&!hasQuantity(answer,'2')&&shortMetric(answer),
  description:'Requested minimum-stock count, not total catalog products',
 },
 sales_1:{
  name:'net_sales_only',check:answer=>amount(answer,'100000')&&!amount(answer,'120000')&&!amount(answer,'20000')&&shortMetric(answer),
  description:'Requested net sales, not gross or refund figures',
 },
 latest_1:{
  name:'latest_sale_amount',check:answer=>amount(answer,'69000')&&shortMetric(answer),
  description:'Most recent sale amount without unrelated report dump',
 },
 growth_2:{
  name:'equal_period_sales',check:answer=>amount(answer,'100000')&&amount(answer,'80000')&&
   hasWord(answer,/davr|hafta|7\s*kun/iu)&&answer.length<=700,
  description:'Compare both verified equal periods rather than quote one uncontextualized total',
 },
 growth_5:{
  name:'profit_caution',check:answer=>hasWord(answer,/foyda/iu)&&
   hasWord(answer,/isbotlamaydi|aniq\s+emas|aytib\s+bo[‘’ʻʼ']lmaydi/iu)&&
   !hasWord(answer,/sof\s+foyda\s+oshdi(?:\.|!|$)/iu)&&answer.length<=520,
  description:'Sales comparison alone cannot prove net profit growth',
 },
 debt_1:{
  name:'receivable_total',check:answer=>amount(answer,'150000')&&
   hasWord(answer,/mijoz|olinadigan/iu)&&shortMetric(answer),
  description:'Receivable balance must not be confused with supplier payable',
 },
 debt_2:{
  name:'debt_due_unknown',check:answer=>hasWord(answer,/muddat/iu)&&
   hasWord(answer,/aniqlanmagan|tekshir|noma[‘’ʻʼ']lum|tasdiqlanmagan|aytib\s+bo[‘’ʻʼ']lmaydi/iu)&&
   answer.length<=550,
  description:'Current receivables do not establish which debts are overdue',
 },
 debt_3:{
  name:'debt_direction',check:answer=>hasWord(answer,/mijoz|olinadigan/iu)&&
   hasWord(answer,/ta[‘’ʻʼ']minotchi|to[‘’ʻʼ']lanadigan/iu)&&answer.length<=650,
  description:'Receivable and payable balances are different business obligations',
 },
 expenses_1:{
  name:'expense_records_not_profit',check:answer=>amount(answer,'0')&&
   hasWord(answer,/xarajat|yozuv/iu)&&!hasWord(answer,/sof\s+foyda\s+(?:yuqori|katta|oshdi)/iu)&&
   answer.length<=380,
  description:'Recorded expense total is zero, not established business profitability',
 },
 expenses_2:{
  name:'zero_expenses_caution',check:answer=>hasWord(answer,/xarajat/iu)&&hasWord(answer,/foyda/iu)&&
   hasWord(answer,/emas|isbotlamaydi|aniq\s+emas|degan\s+gap\s+emas/iu)&&answer.length<=600,
  description:'Missing expense records do not prove positive net profit',
 },
 restock_2:{
  name:'no_immediate_purchase',check:answer=>hasQuantity(answer,'2')&&
   hasWord(answer,/sotilish|yetkaz|muddat|tekshir|reja/iu)&&
   !hasWord(answer,/buyurtma\s+(?:yaratildi|bajarildi|berildi)/iu)&&answer.length<=600,
  description:'Low-stock counts trigger review, not an automatic purchase',
 },
 restock_3:{
  name:'restock_uncertainty',check:answer=>hasWord(answer,/28/)&&hasWord(answer,/7/)&&
   hasWord(answer,/taxmin|aniq\s+emas|kafolatlanmaydi|oldindan\s+aytib\s+bo[‘’ʻʼ']lmaydi/iu)&&answer.length<=650,
  description:'28-day observations cannot guarantee precise future seven-day demand',
 },
 restock_5:{
  name:'restock_plan_only',check:answer=>hasWord(answer,/reja|tekshir|bosqich/iu)&&
   !hasWord(answer,/(?:buyurtma|kirim|xarid)\s+(?:yaratildi|bajarildi|tasdiqlandi)/iu)&&
   answer.length<=900,
  description:'Read-only planning must never claim execution of a purchase or stock receipt',
 },
});
export const AI_AUTOMATED_QUALITY_CASES=Object.freeze(Object.keys(rules));
export function assessSyntheticAnswer({id,status,answer}={}){
 const rule=rules[id];
 if(!rule)return {status:'human_review',rule:null,reason:'No deterministic relevance rubric for this question'};
 if(status!=='answered'||typeof answer!=='string')return {status:'fail',rule:rule.name,reason:'No validated final answer'};
 return {status:rule.check(answer)?'pass':'fail',rule:rule.name,
  reason:rule.description};
}
export function summarizeQualityChecks(items=[]){
 const scored=items.filter(r=>r.quality?.rule);
 return {automatedChecks:scored.length,passed:scored.filter(r=>r.quality.status==='pass').length,
  failed:scored.filter(r=>r.quality.status==='fail').length,
  requiresHumanReview:items.length,coverage:items.length?scored.length/items.length:0};
}
