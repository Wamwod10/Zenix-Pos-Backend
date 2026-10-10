import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreDrillTargets} from '../scripts/verifyRestoreDrill.mjs';
test('restore drill verifier rejects production, remote, overrides and same target',()=>{
 const valid='postgres://operator:test-only@localhost/recovery_test_source',target='postgres://operator:test-only@127.0.0.1/recovery_test_target';
 assert.equal(restoreDrillTargets(valid,target)[0].port,'5432');
 for(const bad of ['postgres://operator:test-only@production.neon.tech/recovery_test_source','postgres://operator:test-only@localhost/production_test',valid+'?host=neon.tech',valid+'?options=unsafe','bad'])assert.throws(()=>restoreDrillTargets(bad,target));
 assert.throws(()=>restoreDrillTargets(valid,valid.replace('localhost','127.0.0.1')));
});
