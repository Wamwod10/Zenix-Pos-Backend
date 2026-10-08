import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLING_PLANS } from '../src/config/billing.js';
import { buildBillingDraftMetadata } from '../src/services/billingDraftMetadata.js';

test('payment purpose and intent come from validated server calculation, never browser metadata', () => {
  const spoofed = { metadata:{ purpose:'LIFETIME, unlimited stores', intent:'ACTIVATE', activeStores:999, note:'customer memo' } };
  const verified={ type:'LICENSE',plan:'MONTHLY',intent:'RENEW',extraStoreCount:0,activeStores:2 };
  const out=buildBillingDraftMetadata(spoofed,verified);
  assert.equal(out.purpose,`${BILLING_PLANS.MONTHLY.label} tarif`);
  assert.equal(out.intent,'RENEW');
  assert.equal(out.activeStores,2);
  assert.equal(out.note,'customer memo');
  assert.equal(spoofed.metadata.purpose,'LIFETIME, unlimited stores');
});
test('extra branch payment purpose matches validated branch count',()=>{
  const out=buildBillingDraftMetadata({metadata:{purpose:'1 filial'}}, {type:'EXTRA',plan:'ANNUAL',intent:'EXTRA',extraStoreCount:5,activeStores:2});
  assert.match(out.purpose,/5 ta/);
  assert.equal(out.intent,'EXTRA');
});
