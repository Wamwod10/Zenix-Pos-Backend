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
