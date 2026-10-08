import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSchema } from '../src/routes/billing.js';

test('payment draft API rejects impossible calendar dates and contradictory type/intent',()=>{
  const base={type:'LICENSE',plan:'MONTHLY',intent:'RENEW',selectedEndDate:'2026-12-08',extraStoreCount:0};
  assert.equal(draftSchema.safeParse(base).success,true);
  for(const invalid of [
    {...base,selectedEndDate:'2026-02-31'},
    {...base,selectedEndDate:'2026-13-01'},
    {...base,intent:'EXTRA'},
    {...base,type:'EXTRA',intent:'RENEW'},
  ])assert.equal(draftSchema.safeParse(invalid).success,false,JSON.stringify(invalid));
  assert.equal(draftSchema.safeParse({type:'EXTRA',intent:'EXTRA',extraStoreCount:2}).success,true);
});
