import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationControlSchema } from '../src/services/platformOrganization.js';
import { hasPermission } from '../src/lib/permissions.js';

test('only PLATFORM_ADMIN can use platformAdmin permission',()=>{
  assert.equal(hasPermission({appRole:'PLATFORM_ADMIN'},'platformAdmin'),true);
  for(const role of ['OWNER','ADMIN','MANAGER','CASHIER'])assert.equal(hasPermission({appRole:role,permissionOverrides:{platformAdmin:true}},'platformAdmin'),false);
});
test('control schema requires audit reason and exact action arguments',()=>{
  assert.equal(organizationControlSchema.safeParse({action:'SUSPEND',reason:'Payment fraud detected'}).success,true);
  assert.equal(organizationControlSchema.safeParse({action:'RESTORE',reason:''}).success,false);
  assert.equal(organizationControlSchema.safeParse({action:'SUSPEND',reason:'Explained reason',plan:'ANNUAL'}).success,false);
  assert.equal(organizationControlSchema.safeParse({action:'SET_LICENSE',plan:'ANNUAL',expiryDate:'2027-01-31',storeLimit:3,reason:'Manual bank correction'}).success,true);
  assert.equal(organizationControlSchema.safeParse({action:'SET_LICENSE',plan:'ANNUAL',expiryDate:'2027-02-30',storeLimit:3,reason:'Manual bank correction'}).success,false);
  assert.equal(organizationControlSchema.safeParse({action:'SET_LICENSE',plan:'ANNUAL',expiryDate:'2027-01-31',storeLimit:0,reason:'Manual bank correction'}).success,false);
});
