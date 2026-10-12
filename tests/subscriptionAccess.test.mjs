import test from 'node:test';
import assert from 'node:assert/strict';
import {requireActiveLicense} from '../src/middleware/auth.js';
import {assertBillingDraftCurrent} from '../src/services/billingDraftIntegrity.js';
import {registerSchema} from '../src/routes/auth.js';
const subscription=await import('../src/services/subscriptions.js').catch(()=>({}));

test('expired products/sales/inventory reads remain accessible, writes fail',()=>{
  for(const path of ['/api/products','/api/sales/page','/api/inventory/receipt-reconciliation']){
    let error;requireActiveLicense({method:'GET',originalUrl:path,user:{licenseStatus:'ACTIVE',licenseDateValid:false}},{},e=>error=e);
    assert.equal(error,undefined);
  }
  for(const method of ['POST','PATCH','DELETE']){
    let error;requireActiveLicense({method,user:{licenseStatus:'ACTIVE',licenseDateValid:false}},{},e=>error=e);
    assert.equal(error?.code,'LICENSE_EXPIRED');
  }
});
test('business write classifier exempts only billing and account security, not user/profile/settings mutations',()=>{
  assert.equal(typeof subscription.isBusinessMutation,'function');
  for(const path of ['/api/sales','/api/inventory/receive','/api/users','/api/users/me/profile','/api/settings/workspace','/api/files'])assert.equal(subscription.isBusinessMutation('POST',path),true);
  for(const [method,path] of [['GET','/api/products'],['POST','/api/auth/logout'],['POST','/api/users/me/password'],['DELETE','/api/users/me/sessions/others'],['POST','/api/billing/payments'],['PATCH','/api/settings/preferences']])assert.equal(subscription.isBusinessMutation(method,path),false);
});
test('PostgreSQL JSONB key order cannot invalidate a matching subscription quote',()=>{
  const subscription={planCode:'START',action:'ACTIVATE',creditAmount:'0.00'};
  const row={type:'LICENSE',plan:'MONTHLY',current_end_date:'2026-01-01',selected_end_date:'2026-01-31',extension_days:31,base_amount:250000,total_amount:250000,extra_store_count:0,extra_store_amount:0,metadata:{subscription:{creditAmount:'0.00',action:'ACTIVATE',planCode:'START'}}};
  const quote={type:'LICENSE',plan:'MONTHLY',currentEndDate:'2026-01-01',selectedEndDate:'2026-01-31',extensionDays:31,baseAmount:250000,totalAmount:250000,extraStoreCount:0,extraStoreAmount:0,subscription};
  assert.doesNotThrow(()=>assertBillingDraftCurrent(row,quote));
  assert.throws(()=>assertBillingDraftCurrent(row,{...quote,subscription:{...subscription,creditAmount:'1.00'}}),{code:'BILLING_DRAFT_STALE'});
});
test('tier-aware registration cannot choose a monthly/yearly billing interval',()=>{
  const input={businessName:'Test',ownerName:'Owner',phone:'998901234567',username:'owner',password:'Password1!',planCode:'START'};
  assert.equal(registerSchema.safeParse(input).success,true);
  for(const startOption of ['MONTHLY','ANNUAL'])assert.equal(registerSchema.safeParse({...input,startOption}).success,false);
});
