import test from 'node:test';
import assert from 'node:assert/strict';
import {formatPaymentReviewMessage} from '../src/services/paymentTelegram.js';
test('admin payment review includes trusted tier, interval, store capacity and fractional due',()=>{
  const message=formatPaymentReviewMessage({type:'LICENSE',plan:'MONTHLY',amount:'315000.25',submitted_at:new Date(),order_id:'TEST',draft_metadata:{subscription:{planCode:'PREMIUM',pricingVersion:1,legacyStoreBonus:2}}});
  assert.match(message,/Premium/);assert.match(message,/Oylik/);assert.match(message,/12 ta/);assert.match(message,/315 000,25/);
});
