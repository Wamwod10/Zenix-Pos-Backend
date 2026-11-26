import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsRevision,assertSettingsRevision,validateWorkspaceValues} from '../src/lib/settingsRevision.js';
test('settings revision is stable across JSON ordering and unrelated metadata',()=>{
 const row={name:'Market',settings:{workspaceSettings:{pos:{discountLimit:20,autoPrintReceipt:false}},billing:{x:1}}};
 const same={...row,settings:{workspaceSettings:{pos:{autoPrintReceipt:false,discountLimit:20}},billing:{x:2}}};
 assert.equal(settingsRevision(row),settingsRevision(same));
 assert.doesNotThrow(()=>assertSettingsRevision(settingsRevision(row),same));
 assert.doesNotThrow(()=>assertSettingsRevision(undefined,same));
 assert.throws(()=>assertSettingsRevision(settingsRevision(row),{...same,name:'Other'}),e=>e.status===409&&e.code==='SETTINGS_CONFLICT');
 assert.throws(()=>assertSettingsRevision(settingsRevision(row),{...same,settings:{...same.settings,rolePermissions:{ADMIN:{settingsWrite:false}}}}),e=>e.status===409);
});
test('global and branch settings reject invalid values without removing unknown extensions',()=>{
 for(const bad of [{receipt:{width:'A4'}},{receipt:{copies:4}},{receipt:{copies:1.2}},{pos:{discountLimit:101}},{pos:{autoPrintReceipt:'false'}},{businessDay:{closeTime:'25:00'}},{businessDay:{warnBeforeCloseMinutes:-1}},{storeOverrides:{a:{pos:{paymentMethods:{cash:'false'}}}}},{storeOverrides:[]}]){
  assert.throws(()=>validateWorkspaceValues(bad),e=>e.status===400&&e.code==='INVALID_WORKSPACE_SETTING');
 }
 assert.doesNotThrow(()=>validateWorkspaceValues({receipt:{width:'58',copies:2},pos:{discountLimit:0},businessDay:{warnBeforeCloseMinutes:0},storeOverrides:{a:{receipt:{width:'80'}}},extensions:{future:true}}));
 assert.doesNotThrow(()=>validateWorkspaceValues({receipt:{width:80,copies:2}},{receipt:{width:80}}));
});

test('premium receipt options are validated at both organization and branch scope',()=>{
 assert.doesNotThrow(()=>validateWorkspaceValues({receipt:{template:'compact',showPhone:true,showAddress:false},storeOverrides:{a:{receipt:{template:'large'}}}}));
 for(const bad of [{receipt:{template:'custom-css'}},{receipt:{showPhone:'true'}},{storeOverrides:{a:{receipt:{showAddress:1}}}}])assert.throws(()=>validateWorkspaceValues(bad),e=>e.status===400&&e.code==='INVALID_WORKSPACE_SETTING');
});
