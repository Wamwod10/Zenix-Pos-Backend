import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('MVP18 migrations are additive and include cross-tenant payment constraint',()=>{
  const source=['020_extra_store_entitlements.sql','021_mvp18_concurrent_indexes.sql','022_mvp18_guarded_constraints.sql']
    .map(name=>fs.readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).join('\n');
  assert.match(source,/extra_store_entitlements_payment_tenant_fk/);
  assert.match(source,/REFERENCES billing_payments\(organization_id,\s*id\)/);
  assert.doesNotMatch(source,/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});
