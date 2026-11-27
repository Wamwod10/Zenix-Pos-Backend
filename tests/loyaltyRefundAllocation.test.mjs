import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateLoyaltyRefund as allocate,restoredLoyaltyPoints} from '../src/services/loyaltyRefundAllocation.js';
import {sumMoney} from '../src/lib/posMoney.js';
test('mixed tender returns conserve cents across all partial refunds',()=>{
 let prior=0,loyalty=0,monetary=0;
 for(const amount of [0.01,49.99,250.15,699.86]){
  const x=allocate({total:1000.01,loyaltyAmount:333.33,previousReturned:prior,returnAmount:amount});
  assert.equal(sumMoney([x.loyaltyAmount,x.monetaryAmount]),amount);
  prior=sumMoney([prior,amount]);loyalty=sumMoney([loyalty,x.loyaltyAmount]);monetary=sumMoney([monetary,x.monetaryAmount]);
  assert.equal(x.cumulativeLoyaltyAmount,loyalty);assert.equal(x.cumulativeMonetaryAmount,monetary);
 }
 assert.equal(loyalty,333.33);assert.equal(monetary,666.68);
});
test('fully redeemed sale never produces monetary payout',()=>{
 assert.deepEqual(allocate({total:1000,loyaltyAmount:1000,previousReturned:100,returnAmount:0.01}),{loyaltyAmount:0.01,monetaryAmount:0,cumulativeLoyaltyAmount:100.01,cumulativeMonetaryAmount:0});
});
test('regular tender and invalid refund boundaries',()=>{
 assert.equal(allocate({total:100,loyaltyAmount:0,previousReturned:0,returnAmount:50}).monetaryAmount,50);
 for(const override of [{loyaltyAmount:101},{previousReturned:99},{returnAmount:0},{returnAmount:1.001},{total:0},{loyaltyAmount:-1}])assert.throws(()=>allocate({total:100,loyaltyAmount:25,previousReturned:20,returnAmount:50,...override}),RangeError);
});

test('fractional point restoration carries rounding forward and returns exact original points',()=>{
 const args={originalPoints:3,loyaltyAmount:300};
 assert.equal(restoredLoyaltyPoints({...args,cumulativeLoyaltyAmount:0.99}),'0.00');
 assert.equal(restoredLoyaltyPoints({...args,cumulativeLoyaltyAmount:1}),'0.01');
 assert.equal(restoredLoyaltyPoints({...args,cumulativeLoyaltyAmount:299.99}),'2.99');
 assert.equal(restoredLoyaltyPoints({...args,cumulativeLoyaltyAmount:300}),'3.00');
 assert.throws(()=>restoredLoyaltyPoints({...args,cumulativeLoyaltyAmount:301}));
});
