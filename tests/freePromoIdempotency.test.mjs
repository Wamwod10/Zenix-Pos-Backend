import test from 'node:test';
import assert from 'node:assert/strict';
import {activateFreePromo} from '../src/routes/billing.js';

test('retry of zero-cost payment returns its original term without consuming another use',async()=>{
  const calls=[];
  const client={query:async(sql)=>{calls.push(sql);return {rows:sql.includes('FROM organizations')?[{id:'org'}]:[{id:'payment',plan:'MONTHLY',service_period_to:'2027-01-09',status:'APPROVED',promo_code:'FREE30'}]}}};
  assert.deepEqual(await activateFreePromo(client,{organizationId:'org',id:'user'},{code:'FREE30',plan:'MONTHLY',requestId:'request'}),{plan:'MONTHLY',expiryDate:'2027-01-09',paymentId:'payment'});
  assert.equal(calls.filter(sql=>sql.startsWith('UPDATE')||sql.startsWith('INSERT')).length,0);
});
test('idempotency key cannot be reused for another promo or plan',async()=>{
  const client={query:async sql=>({rows:sql.includes('FROM organizations')?[{id:'org'}]:[{id:'payment',plan:'ANNUAL',service_period_to:'2027-01-09',status:'APPROVED',promo_code:'OTHER'}]})};
  await assert.rejects(()=>activateFreePromo(client,{organizationId:'org',id:'user'},{code:'FREE30',plan:'MONTHLY',requestId:'request'}),{code:'IDEMPOTENCY_CONFLICT'});
});
