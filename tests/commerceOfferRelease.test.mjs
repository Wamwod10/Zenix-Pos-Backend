import test from 'node:test';import assert from 'node:assert/strict';import {assertCommerceOfferActivation as check} from '../src/services/commerceOfferRelease.js';
test('release gate blocks only new activation, not disabled configuration or rollback',()=>{
 for(const previous of [undefined,{}, {enabled:false}])assert.throws(()=>check(previous,{enabled:true},false),{code:'COMMERCE_OFFERS_NOT_AVAILABLE'});
 for(const [previous,next] of [[undefined,{enabled:false}],[{enabled:true},{enabled:false}],[{enabled:true},{enabled:true}],[{enabled:true},undefined]])assert.doesNotThrow(()=>check(previous,next,false));
 assert.doesNotThrow(()=>check(undefined,{enabled:true},true));
});
