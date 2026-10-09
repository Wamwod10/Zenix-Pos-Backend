import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { quoteExtraStore, effectiveStoreLimit, coveredExtraStoreCount } from '../src/services/extraStoreEntitlements.js';

const base={today:'2026-10-08',licenseExpiry:'2027-07-08',plan:'ANNUAL',count:1};

test('additional branch supports independent monthly and annual service periods',()=>{
  assert.deepEqual(quoteExtraStore({...base,duration:'MONTHLY'}),{
    selectedEndDate:'2026-11-08',extensionDays:31,amount:120000,
  });
  assert.deepEqual(quoteExtraStore({...base,duration:'ANNUAL',count:2}),{
    selectedEndDate:'2027-10-08',extensionDays:365,amount:2200000,
  });
});

test('until-license branch price uses calendar months and exact target expiry',()=>{
  const quote=quoteExtraStore({...base,duration:'UNTIL_LICENSE'});
  assert.equal(quote.amount,825000);
  assert.equal(quote.selectedEndDate,'2027-07-08');
});

test('month-end billing never creates invalid dates',()=>{
  assert.equal(quoteExtraStore({...base,today:'2026-01-31',licenseExpiry:'2026-04-30',duration:'MONTHLY'}).selectedEndDate,'2026-02-28');
});

test('invalid counts, expired license and invalid duration cannot be quoted',()=>{
  for(const change of [{count:0},{count:21},{count:1.5},{licenseExpiry:'2026-10-08'},{duration:'FOREVER'}]){
    assert.throws(()=>quoteExtraStore({...base,...change}));
  }
});

test('effective store limit includes active entitlements only',async()=>{
  const calls=[];
  const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[{count:2}]}}};
  assert.equal(await effectiveStoreLimit(db,{id:'org-1',store_limit:3,timezone:'Asia/Tashkent'}),5);
  assert.match(calls[0].sql,/expires_on>\$2::date/);
  assert.deepEqual(calls[0].params.slice(0,1),['org-1']);
});

test('MVP18 migrations are additive and include cross-tenant payment constraint',()=>{
  const source=['020_extra_store_entitlements.sql','021_mvp18_concurrent_indexes.sql','022_mvp18_guarded_constraints.sql','023_validate_extra_store_constraints.sql']
    .map(name=>fs.readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).join('\n');
  assert.match(source,/extra_store_entitlements_payment_tenant_fk/);
  assert.match(source,/REFERENCES billing_payments\(organization_id,\s*id\)/);
  assert.doesNotMatch(source,/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});

test('extra-store pricing counts the complete period beyond 120 months',async()=>{
  const {billableMonths,priceExtraStoreByMonths}=await import('../src/config/billing.js');
  assert.equal(billableMonths('2026-10-08','2036-11-08'),121);
  assert.equal(priceExtraStoreByMonths('MONTHLY','2026-10-08','2036-11-08',1),14520000);
});

test('renewal charges for passes that expire before the new license term ends',async()=>{
  const q=[];
  const client={query:async(sql,params)=>{q.push({sql,params});return {rows:[{count:0}]};}};
  assert.equal(await coveredExtraStoreCount(client,{id:'org-1'},'2027-01-01','2028-01-01'),0);
  assert.match(q[0].sql,/expires_on>=\$3::date/);
  assert.deepEqual(q[0].params,['org-1','2027-01-01','2028-01-01']);
});

test('read-only reconciliation identifies surplus branches deterministically',async()=>{
  const {storeLimitReconciliation}=await import('../src/services/extraStoreEntitlements.js');
  const queries=[];
  const db={query:async(sql,params)=>{
    queries.push([sql,params]);
    if(sql.includes('COALESCE(SUM(quantity)'))return {rows:[{count:1}]};
    return {rows:[{id:'old',name:'Main'},{id:'middle',name:'East'},{id:'new',name:'West'}]};
  }};
  const result=await storeLimitReconciliation(db,{id:'org',store_limit:1,timezone:'Asia/Tashkent'});
  assert.equal(result.effectiveLimit,2);
  assert.equal(result.overLimit,1);
  assert.deepEqual(result.candidates,[{id:'new',name:'West'}]);
  assert.equal(result.automaticClosure,false);
  assert.match(queries[1][0],/ORDER BY created_at ASC,id ASC/);
});
