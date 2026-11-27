import test from 'node:test';import assert from 'node:assert/strict';
import {promotionPolicySchema,catalogPromotion,resolveSalePromotion,assertPromotionCatalog} from '../src/services/promotionPolicy.js';
const p='11111111-1111-4111-8111-111111111111',s='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const rule={id,enabled:true,productId:p,storeIds:[s],startsAt:'2026-01-01T00:00:00Z',endsAt:'2027-01-01T00:00:00Z',kind:'BUY_GET',buy:2,free:1,maxGroups:10};
const settings={workspaceSettings:{promotions:{enabled:true,rules:[rule]}}},product={id:p,unit:'dona',sell_price:'100.00'},now='2026-11-27T00:00:00Z',pricing={gross:300,lineTotal:300};
test('explicit quote is recomputed against server catalog, old clients keep old pricing',()=>{
 const q=catalogPromotion({product,quantity:3,storeId:s,settings,now});assert.equal(q.net,200);
 const args={product,line:{quantity:3,unitPrice:100,discountPercent:0},storeId:s,settings,now,pricing};
 assert.equal(resolveSalePromotion(args),pricing);
 const applied=resolveSalePromotion({...args,line:{...args.line,promotionQuote:{ruleId:id,net:200}}});
 assert.equal(applied.lineTotal,200);assert.equal(applied.promotion.ruleId,id);
 for(const change of [{promotionQuote:{ruleId:id,net:1}},{discountPercent:5},{unitPrice:99},{metadata:{packUnit:'box'}}])assert.throws(()=>resolveSalePromotion({...args,line:{...args.line,promotionQuote:{ruleId:id,net:200},...change}}));
 assert.throws(()=>resolveSalePromotion({...args,settings:{},line:{...args.line,promotionQuote:{ruleId:id,net:200}}}));
});
test('settings validate even inactive rules and reject duplicate IDs',()=>{
 assert.ok(promotionPolicySchema.safeParse({enabled:false,rules:[rule]}).success);
 for(const rules of [[{...rule,buy:0}],[{...rule,storeIds:[s,s]}],[{...rule,endsAt:rule.startsAt}],[rule,rule]])assert.equal(promotionPolicySchema.safeParse({enabled:false,rules}).success,false);
});
test('catalog lookup scoped to tenant for both product and store',async()=>{
 const calls=[];await assertPromotionCatalog({query:async(sql,values)=>{calls.push({sql,values});return {rows:[{id:'x'}]}}},p,{rules:[rule]});
 assert.equal(calls.length,2);for(const x of calls){assert.match(x.sql,/organization_id=\$1/);assert.equal(x.values[0],p)}
 await assert.rejects(()=>assertPromotionCatalog({query:async()=>({rows:[]})},p,{rules:[rule]}));
});
