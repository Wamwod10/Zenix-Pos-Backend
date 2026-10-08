import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewLicenseStatus } from '../src/services/billingReview.js';

test('manual suspension persists after approved renewal or rejected payment',()=>{
  for(const decision of ['APPROVED','REJECTED']){
    assert.equal(reviewLicenseStatus({currentStatus:'SUSPENDED',decision,expiryDate:'2099-12-31',timezone:'Asia/Tashkent'}),'SUSPENDED');
  }
});
test('normal renewal activates license, expiry check preserves valid license on rejected payment',()=>{
  assert.equal(reviewLicenseStatus({currentStatus:'PAYMENT_REQUIRED',decision:'APPROVED'}),'ACTIVE');
  assert.equal(reviewLicenseStatus({currentStatus:'ACTIVE',decision:'REJECTED',expiryDate:'2099-12-31',timezone:'Asia/Tashkent'}),'ACTIVE');
  assert.equal(reviewLicenseStatus({currentStatus:'EXPIRED',decision:'REJECTED',expiryDate:'2020-01-01',timezone:'Asia/Tashkent'}),'REJECTED');
});
