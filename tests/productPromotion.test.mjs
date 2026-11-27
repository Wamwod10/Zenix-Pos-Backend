import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateProductPromotion as evaluate} from '../src/services/productPromotion.js';
const rule={id:'a',enabled:true,productId:'p',storeIds:['s'],startsAt:'2026-11-01T00:00:00Z',endsAt:'2026-12-01T00:00:00Z',kind:'BUY_GET',buy:2,free:1,maxGroups:2};
const input={line:{productId:'p',unit:'dona',quantity:8,unitPrice:1234.56},storeId:'s',now:'2026-11-27T00:00:00Z',rules:[rule]};
test('2+1 counts only full bundles and honors group cap',()=>{
 assert.deepEqual(evaluate(input),{ruleId:'a',kind:'BUY_GET',freeUnits:2,gross:9876.48,discount:2469.12,net:7407.36});
 assert.equal(evaluate({...input,line:{...input.line,quantity:2}}),null);
});
test('quantity discount and buy/get do not stack; ties deterministic',()=>{
 const pct={...rule,id:'b',kind:'QUANTITY_PERCENT',minQuantity:5,discountBps:3000};
 assert.equal(evaluate({...input,rules:[rule,pct]}).ruleId,'b');
 assert.equal(evaluate({...input,rules:[{...rule,id:'z'},rule]}).ruleId,'a');
 assert.equal(evaluate({...input,rules:[rule,{...pct,discountBps:2500}]}).ruleId,'a');
});
test('disabled, wrong branch, expired, weighed, packaged and manually discounted lines are excluded',()=>{
 for(const patch of [{storeId:'x'},{now:rule.endsAt},{rules:[{...rule,enabled:false}]},{line:{...input.line,unit:'kg'}},{line:{...input.line,hasManualDiscount:true}},{line:{...input.line,isPackaged:true}}])assert.equal(evaluate({...input,...patch}),null);
});
test('money rounding and invalid configuration fail closed',()=>{
 const pct={...rule,kind:'QUANTITY_PERCENT',minQuantity:1,discountBps:5000};
 assert.equal(evaluate({...input,line:{...input.line,quantity:1,unitPrice:0.01},rules:[pct]}).discount,0.01);
 for(const rules of [[{...rule,buy:0}],[{...rule,endsAt:rule.startsAt}],[rule,rule],[{...pct,discountBps:10001}]])assert.throws(()=>evaluate({...input,rules}),RangeError);
});
