import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hasPermission,ROLES} from '../src/lib/permissions.js';

const actions=['transferView','transferCreate','transferApprove','transferReceive','transferCancel'];
const expected={
  OWNER:     [true,true,true,true,true],
  ADMIN:     [true,true,true,true,true],
  MANAGER:   [true,true,false,true,true],
  CASHIER:   [false,false,false,false,false],
  WAREHOUSE: [true,true,false,true,false],
  SALES:     [false,false,false,false,false],
  PLATFORM_ADMIN:[false,false,false,false,false],
};

for(const [role,allowed] of Object.entries(expected)){
  test(`${role}: transfer role/action default permission matrix`,()=>{
    const user={appRole:role};
    for(let i=0;i<actions.length;i++)assert.equal(hasPermission(user,actions[i]),allowed[i],`${role}/${actions[i]}`);
  });
}

test('organization custom role permissions and actor overrides are evaluated per permission',()=>{
  const manager={appRole:ROLES.MANAGER,rolePermissions:{MANAGER:{transferApprove:true,transferReceive:false}}};
  assert.equal(hasPermission(manager,'transferApprove'),true);
  assert.equal(hasPermission(manager,'transferReceive'),false);
  assert.equal(hasPermission(manager,'transferCreate'),true);
  assert.equal(hasPermission({...manager,permissionOverrides:{transferApprove:false,transferReceive:true}},'transferApprove'),false);
  assert.equal(hasPermission({...manager,permissionOverrides:{transferApprove:false,transferReceive:true}},'transferReceive'),true);
  assert.equal(hasPermission({appRole:ROLES.CASHIER,permissionOverrides:{transferCreate:true}},'transferCreate'),true);
  assert.equal(hasPermission({appRole:ROLES.OWNER,permissionOverrides:{transferCreate:false}},'transferCreate'),true);
});

test('tenant role permissions cannot grant platform administration',()=>{
  for(const role of [ROLES.OWNER,ROLES.ADMIN,ROLES.MANAGER,ROLES.CASHIER,ROLES.WAREHOUSE]){
    const actor={appRole:role,rolePermissions:{[role]:{platformAdmin:true,'*':true}},permissionOverrides:{platformAdmin:true,'*':true}};
    assert.equal(hasPermission(actor,'platformAdmin'),false);
    assert.equal(hasPermission(actor,'*'),false);
  }
});

test('all transfer mutations enforce the server-side action permission and scoped store',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.join(here,'../src/routes/inventory.js'),'utf8');
  const wiring=[
    ['/transfers','transferCreate'],
    ['/transfers/:id/dispatch','transferApprove'],
    ['/transfers/:id/receive','transferReceive'],
    ['/transfers/:id/cancel','transferCancel'],
  ];
  for(const [route,permission] of wiring){
    assert.ok(source.includes(`router.post("${route}",requirePermission("${permission}")`),`Expected permission ${permission} for ${route}`);
  }
  assert.match(source,/router\.post\("\/transfers".*?[\s\S]*?assertStoreScope\(req\.user,input\.fromStoreId\)/);
  assert.match(source,/router\.post\("\/transfers\/:id\/dispatch".*?[\s\S]*?assertStoreScope\(req\.user,transfer\.from_store_id\)/);
  assert.match(source,/router\.post\("\/transfers\/:id\/receive".*?[\s\S]*?assertStoreScope\(req\.user,transfer\.to_store_id\)/);
  assert.match(source,/router\.post\("\/transfers\/:id\/cancel".*?[\s\S]*?assertStoreScope\(req\.user,transfer\.from_store_id\)/);
});
