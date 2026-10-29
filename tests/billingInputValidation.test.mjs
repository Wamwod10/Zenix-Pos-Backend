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

test('extra store count distinguishes omitted from explicitly blank or non-integer input',()=>{
 const base={type:'EXTRA',intent:'EXTRA'};
 for(const extraStoreCount of ['',null,false,true,'  ','1.1',1.1,-1,'21']){
  assert.equal(draftSchema.safeParse({...base,extraStoreCount}).success,false,
    'malformed count accepted: '+String(extraStoreCount));
 }
 for(const extraStoreCount of [0,1,2,'0','2','20']){
  const result=draftSchema.safeParse({...base,extraStoreCount});
  assert.equal(result.success,true,JSON.stringify(result.error?.issues));
  assert.equal(result.data.extraStoreCount,Number(extraStoreCount));
 }
 assert.equal(draftSchema.parse(base).extraStoreCount,0,'omitted count retains legacy default');
});

test('read-only billing draft retrieval never cancels quotes in the database',async()=>{
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../src/routes/billing.js',import.meta.url),'utf8');
 const start=source.indexOf('router.get("/draft",');
 const end=source.indexOf('router.post("/draft",',start);
 assert.ok(start>=0&&end>start);
 const readHandler=source.slice(start,end);
 assert.match(readHandler,/requirePermission\("moduleBilling"\)/);
 assert.match(readHandler,/assertBillingDraftCurrent/);
 assert.match(readHandler,/stale:true/);
 assert.doesNotMatch(readHandler,/UPDATE\s+billing_drafts|DELETE\s+FROM\s+billing_drafts/i);
 const paymentStart=source.indexOf('router.post("/payments",');
 assert.match(source.slice(paymentStart),/assertBillingDraftCurrent/,'payment must still reject stale quotes');
});
