import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
