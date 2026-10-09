import test from 'node:test';
import assert from 'node:assert/strict';
import {claimOrganizationTrial,registerSchema} from '../src/routes/auth.js';

test('same normalized business contact cannot claim another trial',async()=>{
  const claims=new Set();
  const client={query:async(_sql,args)=>{const used=claims.has(args[1]);claims.add(args[1]);return {rowCount:used?0:1,rows:used?[]:[{id:'claim'}]}}};
  await claimOrganizationTrial(client,'org-a','+998 90 123 45 67');
  await assert.rejects(()=>claimOrganizationTrial(client,'org-b','998901234567'),{code:'TRIAL_ALREADY_USED'});
});
test('server registration rejects malformed business phones',()=>{
  const input={businessName:'Test',ownerName:'Owner',username:'owner',password:'password1',phone:'invalid'};
  assert.equal(registerSchema.safeParse(input).success,false);
});
