import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkspaceTimeSettings} from '../src/lib/workspaceTimeSettings.js';
import {organizationBusinessDateISO} from '../src/lib/businessDate.js';

test('workspace timezone and start times reject invalid global/branch values',()=>{
 for(const input of [{organization:{timezone:'Missing/Timezone'}},{organization:{timezone:42}},{businessDay:{startTime:'24:00'}},{businessDay:{startTime:'8:30'}},{storeOverrides:{a:{businessDay:{startTime:'12:60'}}}}])assert.throws(()=>validateWorkspaceTimeSettings(input),e=>e.status===400);
 assert.doesNotThrow(()=>validateWorkspaceTimeSettings({organization:{timezone:'Asia/Tashkent'},businessDay:{startTime:'04:30'},storeOverrides:{a:{businessDay:{startTime:'23:59'}}}}));
});
test('branch business-day override is authoritative without changing global callers',()=>{
 const org={timezone:'Asia/Tashkent',settings:{workspaceSettings:{businessDay:{startTime:'04:00'},storeOverrides:{a:{businessDay:{startTime:'08:00'}}}}}},now=new Date('2026-10-25T01:00:00Z');
 assert.equal(organizationBusinessDateISO(org,now),'2026-10-25');
 assert.equal(organizationBusinessDateISO(org,now,'a'),'2026-10-24');
 assert.equal(organizationBusinessDateISO(org,now,'b'),'2026-10-25');
});
