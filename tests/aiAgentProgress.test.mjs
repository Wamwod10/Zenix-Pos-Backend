import test from 'node:test';
import assert from 'node:assert/strict';
import {recordAgentProgress,getAgentProgress} from '../src/services/aiAgentProgress.js';
const actor={organizationId:'business-a',id:'owner',sessionId:'session-a',appRole:'OWNER',permissionOverrides:{},rolePermissions:{}};
test('progress reports real stages only to the original scoped session',()=>{
 const id='11111111-1111-4111-8111-111111111111';
 recordAgentProgress(actor,id,'understanding');recordAgentProgress(actor,id,'reading_inventory');
 assert.deepEqual(getAgentProgress(actor,id),{phase:'reading_inventory'});
 for(const patch of [{organizationId:'business-b'},{id:'other'},{sessionId:'other'},{appRole:'SALES'}])assert.throws(()=>getAgentProgress({...actor,...patch},id),e=>[403,404].includes(e.status));
 assert.throws(()=>recordAgentProgress(actor,id,'fake_percentage'),/phase/i);
 recordAgentProgress(actor,id,'complete');assert.deepEqual(getAgentProgress(actor,id),{phase:'complete'});
});
test('expired progress is unavailable, never an invented stage',()=>{
 const id='22222222-2222-4222-8222-222222222222';
 recordAgentProgress(actor,id,'composing',0);assert.throws(()=>getAgentProgress(actor,id,60001),e=>e.status===404);
});
