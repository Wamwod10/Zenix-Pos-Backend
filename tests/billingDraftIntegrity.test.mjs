import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBillingDraftCurrent, draftRecalculationInput } from '../src/services/billingDraftIntegrity.js';

const baseline = {
  type: 'LICENSE', plan:'MONTHLY', current_end_date:'2026-11-08',
  selected_end_date:'2026-12-08', extension_days:30, base_amount:350000,
  extra_store_count:1, extra_store_amount:120000, total_amount:470000,
  metadata: {intent:'RENEW', activeStores:3},
};
const computed = {
  type:'LICENSE', plan:'MONTHLY', intent:'RENEW', currentEndDate:'2026-11-08',
  selectedEndDate:'2026-12-08', extensionDays:30, baseAmount:350000,
  extraStoreCount:1, extraStoreAmount:120000, totalAmount:470000, activeStores:3,
};

test('an unchanged quote may be paid; PostgreSQL numeric strings and Date objects compare correctly', () => {
  assert.doesNotThrow(() => assertBillingDraftCurrent({
    ...baseline, total_amount:'470000', selected_end_date:new Date('2026-12-08T00:00:00Z'),
  },computed));
  assert.deepEqual(draftRecalculationInput(baseline), {
    type:'LICENSE', plan:'MONTHLY', intent:'RENEW', selectedEndDate:'2026-12-08',extraStoreCount:1,metadata:{},
  });
});

test('stale pricing, plan, expiry and branch-count quotes are rejected before payment insert',()=>{
  const cases = [
    {...computed,baseAmount:300000},
    {...computed,totalAmount:350000},
    {...computed,plan:'ANNUAL'},
    {...computed,currentEndDate:'2026-12-01'},
    {...computed,selectedEndDate:'2027-01-01'},
    {...computed,activeStores:4},
    {...computed,extraStoreCount:2},
  ];
  for (const variant of cases) {
    assert.throws(()=>assertBillingDraftCurrent(baseline,variant),
      error => error.status === 409 && error.code === 'BILLING_DRAFT_STALE');
  }
});

test('extra branch draft always recalculates as EXTRA even if metadata is corrupted',()=>{
  assert.equal(draftRecalculationInput({...baseline,type:'EXTRA',metadata:{intent:'ACTIVATE'}}).intent,'EXTRA');
});
