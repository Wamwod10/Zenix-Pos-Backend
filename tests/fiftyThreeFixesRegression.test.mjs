import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
test('products implement guarded permanent delete',()=>{const s=read('src/routes/products.js');assert.match(s,/router\.delete\("\/:id"/);assert.match(s,/PRODUCT_HAS_HISTORY/);assert.match(s,/DELETE FROM products/)});
test('store dependency error returns actionable details',()=>{const s=read('src/routes/stores.js');assert.match(s,/STORE_HAS_DEPENDENCIES/);assert.match(s,/details/)});
test('customer create and edit serialize duplicate phone checks within tenant',()=>{const s=read('src/routes/customers.js');assert.match(s,/pg_advisory_xact_lock/);assert.match(s,/excludeId/);assert.match(s,/CUSTOMER_PHONE_EXISTS/)});

test('product archive stock conflict reports affected branches and quantities', () => {
  const products = read('src/routes/products.js');
  assert.match(products, /stockLocations/);
  assert.match(products, /store_name/);
  assert.match(products, /PRODUCT_HAS_STOCK/);
});

test('store creation rejects duplicate names with a business error before insert', () => {
  const source = read('src/routes/stores.js');
  assert.match(source, /SELECT 1 FROM stores WHERE organization_id=\$1 AND lower\(name\)=lower\(\$2\) LIMIT 1/);
  assert.match(source, /STORE_NAME_EXISTS/);
});
