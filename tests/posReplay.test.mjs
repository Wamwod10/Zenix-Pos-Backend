import test from 'node:test';import assert from 'node:assert/strict';
import * as replay from '../src/services/posReplay.js';
test('reused reference cannot return another cashier, branch or payload',()=>{
 assert.equal(typeof replay.assertSaleReplay,'function');
 const sale={store_id:'branch-a',seller_id:'cashier-a',metadata:{requestFingerprint:'first'}};
 for(const input of [{storeId:'branch-b',actorId:'cashier-a',fingerprint:'first'},{storeId:'branch-a',actorId:'cashier-b',fingerprint:'first'},{storeId:'branch-a',actorId:'cashier-a',fingerprint:'second'}])assert.throws(()=>replay.assertSaleReplay(sale,input),error=>error.code==='IDEMPOTENCY_CONFLICT');
 assert.doesNotThrow(()=>replay.assertSaleReplay(sale,{storeId:'branch-a',actorId:'cashier-a',fingerprint:'first'}));
});
test('refund retry matches sale, actor, product and quantity',()=>{
 assert.equal(typeof replay.assertRefundReplay,'function');
 const row={sale_id:'sale-a',created_by:'actor',product_id:'product',quantity:'1',reason:'broken',refund_method:'card'};
 const input={saleId:'sale-a',actorId:'actor',productId:'product',quantity:1,reason:'broken',refundMethod:'card'};
 assert.doesNotThrow(()=>replay.assertRefundReplay(row,input));
 assert.throws(()=>replay.assertRefundReplay(row,{...input,saleId:'sale-b'}));
 assert.throws(()=>replay.assertRefundReplay(row,{...input,quantity:2}));
});

test('new refund retries bind the complete validated financial intent',()=>{
 const input={saleId:'sale',actorId:'actor',productId:'product',quantity:1,reason:'broken',refundMethod:'original',refundShiftId:'shift-a',refundBreakdown:{cash:100,card:0,transfer:0},metadata:{note:'return'}};
 const {saleId,actorId,...intent}=input;
 const row={sale_id:saleId,created_by:actorId,product_id:input.productId,quantity:'1',reason:input.reason,refund_method:input.refundMethod,metadata:{requestFingerprint:replay.requestFingerprint(intent)}};
 assert.doesNotThrow(()=>replay.assertRefundReplay(row,input));
 for(const changed of [{refundShiftId:'shift-b'},{refundBreakdown:{cash:0,card:100,transfer:0}},{metadata:{note:'changed'}}]){
  assert.throws(()=>replay.assertRefundReplay(row,{...input,...changed}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 }
});
