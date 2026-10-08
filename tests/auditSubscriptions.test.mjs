import test from 'node:test';
import assert from 'node:assert/strict';
import {auditSubscriptionIntegrity} from '../src/db/auditSubscriptions.js';

const fakeDb=(licenses,limits)=>({
  query:async(sql)=>sql.includes('stored_active_but_expired')
    ? {rows:[{active_without_expiry:licenses[0],stored_active_but_expired:licenses[1]}]}
    : {rows:[{over_limit_organizations:limits}]},
});

test('read-only license audit accepts paid tenants with valid expiry and branch limits',async()=>{
  const result=await auditSubscriptionIntegrity(fakeDb([0,0],0));
  assert.deepEqual(result,{ok:true,blockers:{activeWithoutExpiry:0,overLimitOrganizations:0},information:{storedActiveButExpired:0}});
});
test('read-only license audit flags unlimited active accounts and over-limit branches',async()=>{
  const result=await auditSubscriptionIntegrity(fakeDb([3,9],2));
  assert.deepEqual(result,{ok:false,blockers:{activeWithoutExpiry:3,overLimitOrganizations:2},information:{storedActiveButExpired:9}});
});
test('expired active status is informational because access middleware checks expiry date',async()=>{
  const result=await auditSubscriptionIntegrity(fakeDb([0,5],0));
  assert.equal(result.ok,true);
  assert.equal(result.information.storedActiveButExpired,5);
});
