import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoConflictingBillingReview } from '../src/services/pendingBillingReview.js';

test('a different pending payment type still blocks a new submission',async()=>{
  let seen;
  const client={query:async(sql,args)=>{seen={sql,args};return {rowCount:1};}};
  await assert.rejects(assertNoConflictingBillingReview(client,'org-a'),
    e=>e.status===409&&e.code==='BILLING_REVIEW_CONFLICT');
  assert.match(seen.sql,/organization_id=\$1 AND status='REVIEW'/);
  assert.doesNotMatch(seen.sql,/type=\$\d/);
  assert.deepEqual(seen.args,['org-a',null]);
});

test('no pending review permits submission and approval excludes self',async()=>{
  const client={query:async()=>({rowCount:0})};
  await assert.doesNotReject(assertNoConflictingBillingReview(client,'org-a'));
  await assert.doesNotReject(assertNoConflictingBillingReview(client,'org-a','review-1'));
});
