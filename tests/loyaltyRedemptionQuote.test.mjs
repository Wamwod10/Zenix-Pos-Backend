import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteLoyaltyRedemption as quote} from '../src/services/loyaltyRedemptionQuote.js';
const policy={enabled:true,valuePerPoint:100,maxShareBps:5000};
test('redemption is opt-in and cannot change existing totals when disabled',()=>{
 assert.deepEqual(quote({policy:{},total:1234.56,balance:100}),{enabled:false,maxPoints:0,points:0,amount:0,remaining:1234.56});
});
test('quote respects sale cap and available whole points',()=>{
 assert.deepEqual(quote({policy,total:1050.99,balance:'50.25',requestedPoints:5}),{enabled:true,maxPoints:5,points:5,amount:500,remaining:550.99});
 assert.equal(quote({policy,total:100000,balance:'2.99'}).maxPoints,2);
 assert.equal(quote({policy,total:100000,balance:'-5.25'}).maxPoints,0);
 assert.equal(quote({policy,total:199.99,balance:100}).maxPoints,0);
});
test('quote rejects over-redemption, fractional points, invalid rates and invalid money',()=>{
 for(const requestedPoints of [6,-1,0.5,NaN])assert.throws(()=>quote({policy,total:1000,balance:20,requestedPoints}),RangeError);
 for(const change of [{valuePerPoint:0},{valuePerPoint:1.5},{maxShareBps:10001},{maxShareBps:0}])assert.throws(()=>quote({policy:{...policy,...change},total:1000,balance:20}),RangeError);
 for(const total of [-1,1.001,Infinity,'NaN'])assert.throws(()=>quote({policy,total,balance:20}),RangeError);
});
test('full cap and large exact amounts preserve money identity',()=>{
 assert.deepEqual(quote({policy:{...policy,maxShareBps:10000},total:300,balance:3,requestedPoints:3}),{enabled:true,maxPoints:3,points:3,amount:300,remaining:0});
 assert.equal(quote({policy:{...policy,valuePerPoint:1,maxShareBps:10000},total:9000000000000,balance:'999999999999999999999999999999',requestedPoints:1}).remaining,8999999999999);
});
