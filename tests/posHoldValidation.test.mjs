import test from 'node:test';
import assert from 'node:assert/strict';
import * as holds from '../src/services/saleHolds.js';
const id='11111111-1111-4111-8111-111111111111';
const payload={storeId:id,shiftId:'',name:'Draft',cart:[{id,cartQty:2,sellPrice:100,discountPercent:10}],customerId:id};
test('hold normalizes absent shift and preserves linked customer and intent',()=>{
 assert.ok(holds.holdSchema);
 const input=holds.holdSchema.parse(payload);
 assert.equal(input.shiftId,null);assert.equal(input.customerId,id);assert.equal(input.cart[0].cartQty,2);
});
test('hold rejects malformed lines, duplicate products and fractional stock precision',()=>{
 assert.ok(holds.holdSchema);
 for(const cart of [[{id:'local',cartQty:1}],[{id,cartQty:0}],[{id,cartQty:0.0001}],Array(2).fill(payload.cart[0])])assert.equal(holds.holdSchema.safeParse({...payload,cart}).success,false);
});
