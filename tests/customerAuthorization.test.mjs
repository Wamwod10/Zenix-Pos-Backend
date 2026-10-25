import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCustomerFinancialWrite} from '../src/services/customerAuthorization.js';
import {hasPermission,ROLES} from '../src/lib/permissions.js';
const defaults={creditLimit:0,defaultCreditDays:0,customerType:'REGULAR',loyaltyTier:'STANDARD'};
for(const appRole of Object.values(ROLES))test(`${appRole} financial settings default`,()=>{
 const user={appRole};
 assert.equal(hasPermission(user,'customerFinancialWrite'),['OWNER','ADMIN'].includes(appRole));
 assert.doesNotThrow(()=>assertCustomerFinancialWrite(user,{name:'Contact',...defaults}));
 for(const [key,value] of Object.entries({creditLimit:100,defaultCreditDays:30,customerType:'VIP',loyaltyTier:'GOLD'})){
  if(['OWNER','ADMIN'].includes(appRole))assert.doesNotThrow(()=>assertCustomerFinancialWrite(user,{[key]:value}));
  else assert.throws(()=>assertCustomerFinancialWrite(user,{[key]:value}),{status:403,code:'CUSTOMER_FINANCIAL_WRITE_FORBIDDEN'});
 }
});
test('grants, explicit denies and platform boundary',()=>{
 for(const appRole of Object.values(ROLES)){
  const granted={appRole,permissionOverrides:{customerFinancialWrite:true}};
  if(appRole==='PLATFORM_ADMIN')assert.throws(()=>assertCustomerFinancialWrite(granted,{creditLimit:1}),{status:403});
  else assert.doesNotThrow(()=>assertCustomerFinancialWrite(granted,{creditLimit:1}));
  if(appRole==='OWNER')assert.doesNotThrow(()=>assertCustomerFinancialWrite({appRole,permissionOverrides:{customerFinancialWrite:false}},{creditLimit:1}));
  else assert.throws(()=>assertCustomerFinancialWrite({appRole,permissionOverrides:{customerFinancialWrite:false}},{creditLimit:1}),{status:403});
 }
 assert.doesNotThrow(()=>assertCustomerFinancialWrite({appRole:'MANAGER',rolePermissions:{MANAGER:{customerFinancialWrite:true}}},{creditLimit:1}));
 assert.throws(()=>assertCustomerFinancialWrite({appRole:'MANAGER',rolePermissions:{MANAGER:{customerFinancialWrite:true}},permissionOverrides:{customerFinancialWrite:false}},{creditLimit:1}),{status:403});
});
test('contact patches omit settings and unchanged persisted values are allowed',()=>{
 const user={appRole:'CASHIER'},current={credit_limit:'125.00',default_credit_days:30,customer_type:'VIP',loyalty_tier:'GOLD'};
 assert.doesNotThrow(()=>assertCustomerFinancialWrite(user,{phone:'123'},current));
 assert.doesNotThrow(()=>assertCustomerFinancialWrite(user,{creditLimit:125,defaultCreditDays:30,customerType:'VIP',loyaltyTier:'GOLD'},current));
 assert.throws(()=>assertCustomerFinancialWrite(user,{creditLimit:0},current),{status:403});
 assert.throws(()=>assertCustomerFinancialWrite(user,{customerType:'REGULAR'},current),{status:403});
});
