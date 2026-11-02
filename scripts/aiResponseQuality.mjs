// Pure, deterministic rubric for synthetic Zenix AI eval cases.
// Heuristics are guardrails, not a replacement for human answer-quality review.
// Never execute tools or read user, tenant, provider or database state here.
const numeric=value=>String(value||'').normalize('NFKC').replace(/[\u00a0\u202f\s,_]/g,'');
const hasQuantity=(answer,value)=>new RegExp('(?:^|[^0-9])'+value+'\\s*(?:ta|dona|mahsulot)(?:[^\\p{L}]|$)','iu').test(answer);
const shortMetric=answer=>typeof answer==='string'&&answer.trim().length>0&&answer.trim().length<=260;
const amount= (answer,value)=>new RegExp('(?:^|[^0-9])'+value+'(?:\\.00)?\\s*(?:so[‘’ʻʼ\u0027]m|UZS)(?:[^\\p{L}]|$)','iu').test(numeric(answer));
const hasWord=(answer,re)=>typeof answer==='string'&&re.test(answer.normalize('NFKC'));
const stockAmount=answer=>hasWord(answer,/(?:7(?:[.,]0+)?\\s*kg|7\\s*kilogram)/iu);
const unitCount=answer=>hasWord(answer,/(?:^|[^\\d])2\\s*dona(?:[^\\p{L}]|$)/iu);
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
    !hasWord(answer,/100\\s*dona\\s*sotil/iu)&&answer.length<=500,
  description:'Most recent sale contains two sold units, not the 100 in its product name',
 },
 ranking_1:{
  name:'quantity_leader',check:answer=>hasWord(answer,/salfetka/iu)&&unitCount(answer)&&
    !hasWord(answer,/100\\s*dona\\s*sotil/iu)&&answer.length<=500,
  description:'Recognize quantity leader and packaging label',
 },
 receipt_4:{
  name:'no_unconfirmed_write',check:answer=>hasWord(answer,/tasdiq/iu)&&
    hasWord(answer,/yo[‘’ʻʼ']q|mumkin emas|bajarilmaydi|kerak|shart/iu)&&
    !hasWord(answer,/kirim\\s+bajarildi(?:\\.|!|$)/iu)&&answer.length<=500,
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
