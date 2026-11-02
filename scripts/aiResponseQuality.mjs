// Pure, deterministic rubric for synthetic Zenix AI eval cases.
// Heuristics are guardrails, not a replacement for human answer-quality review.
// Never execute tools or read user, tenant, provider or database state here.
const numeric=value=>String(value||'').normalize('NFKC').replace(/[\u00a0\u202f\s,_]/g,'');
const hasQuantity=(answer,value)=>new RegExp('(?:^|[^0-9])'+value+'\\s*(?:ta|dona|mahsulot)(?:[^\\p{L}]|$)','iu').test(answer);
const shortMetric=answer=>typeof answer==='string'&&answer.trim().length>0&&answer.trim().length<=260;
const amount= (answer,value)=>new RegExp('(?:^|[^0-9])'+value+'(?:\\.00)?\\s*(?:so[‘’ʻʼ\u0027]m|UZS)(?:[^\\p{L}]|$)','iu').test(numeric(answer));
const rules=Object.freeze({
 inventory_1:{
  name:'catalog_count',check:answer=>hasQuantity(answer,'2')&&!hasQuantity(answer,'0')&&shortMetric(answer),
  description:'Requested catalog count, not the minimum-stock count',
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
