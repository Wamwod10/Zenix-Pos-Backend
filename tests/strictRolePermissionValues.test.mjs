import test from 'node:test';
import assert from 'node:assert/strict';
import {hasPermission,ROLES} from '../src/lib/permissions.js';
import {workspaceSchema} from '../src/routes/settings.js';

const user={appRole:ROLES.MANAGER,permissionOverrides:{},rolePermissions:{}};

test('permission resolver fails closed for malformed stored values',()=>{
 for(const value of ['false','true',1,0,null,{},[],false]){
  assert.equal(hasPermission({...user,permissionOverrides:{billingWrite:value}},'billingWrite'),false,
    'invalid or false per-user value cannot grant billingWrite: '+String(value));
  assert.equal(hasPermission({...user,rolePermissions:{MANAGER:{billingWrite:value}}},'billingWrite'),false,
    'invalid or false role override cannot grant billingWrite: '+String(value));
 }
 assert.equal(hasPermission({...user,permissionOverrides:{billingWrite:true}},'billingWrite'),true);
 assert.equal(hasPermission({...user,rolePermissions:{MANAGER:{billingWrite:true}}},'billingWrite'),true);
 assert.equal(hasPermission({...user,permissionOverrides:{moduleSales:false}},'moduleSales'),false);
 assert.equal(hasPermission({...user,permissionOverrides:{moduleSales:'false'}},'moduleSales'),false);
 assert.equal(hasPermission({...user,permissionOverrides:{moduleSales:true}},'moduleSales'),true);
 // No change to hard platform boundary and owner privileges.
 assert.equal(hasPermission({...user,permissionOverrides:{platformAdmin:true}},'platformAdmin'),false);
 assert.equal(hasPermission({appRole:ROLES.OWNER},'billingWrite'),true);
 assert.equal(hasPermission({appRole:ROLES.PLATFORM_ADMIN},'platformAdmin'),true);
});

test('workspace role overrides reject malformed values before persisting',()=>{
 const valid={rolePermissions:{MANAGER:{moduleSales:true,billingWrite:false}}};
 assert.equal(workspaceSchema.safeParse(valid).success,true);
 for(const value of ['false','true',null,0,1,[],{},'']){
  const result=workspaceSchema.safeParse({rolePermissions:{MANAGER:{billingWrite:value}}});
  assert.equal(result.success,false,'invalid role flag accepted: '+String(value));
 }
 for(const entry of [{MANAGER:null},{MANAGER:'false'},{MANAGER:[]}]){
  assert.equal(workspaceSchema.safeParse({rolePermissions:entry}).success,false);
 }
 assert.equal(workspaceSchema.safeParse({workspaceSettings:{organization:{timezone:'Asia/Tashkent'}}}).success,true);
});
