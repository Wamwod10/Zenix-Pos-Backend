import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertNoLiveProductInventory } from '../src/services/productDeletionGuard.js';

const productRoute = readFileSync(new URL('../src/routes/products.js', import.meta.url), 'utf8');

test('permanent delete checks live stock inside the product row lock and before any child deletion', () => {
  const route = productRoute.slice(productRoute.indexOf('router.delete("/:id"'));
  const lock = route.indexOf('SELECT * FROM products WHERE id=$1 AND organization_id=$2 FOR UPDATE');
  const guard = route.indexOf('assertNoLiveProductInventory(client,orgId,current.id)');
  const childDelete = route.indexOf('DELETE FROM inventory_balances');
  assert.ok(lock >= 0 && lock < guard && guard < childDelete);
});

for (const [name, index] of [['stock balance', 0], ['remaining batch', 1], ['in-stock serial', 2]]) {
  test(`permanent deletion rejects ${name} even with no historical stock movements`, async () => {
    const queries = [];
    const fake = { async query(sql, params) {
      queries.push({ sql, params });
      return { rowCount: queries.length === index + 1 ? 1 : 0 };
    } };
    await assert.rejects(assertNoLiveProductInventory(fake, 'org-a', 'product-a'),
      error => error.status === 409 && error.code === 'PRODUCT_HAS_STOCK');
    assert.equal(queries.length, index + 1);
    assert.ok(queries.every(query => query.params.join(':') === 'org-a:product-a'));
  });
}

test('empty inventory is safe for subsequent historical checks', async () => {
  const queries = [];
  await assertNoLiveProductInventory({ async query(sql) { queries.push(sql); return { rowCount: 0 }; } }, 'org-a', 'product-a');
  assert.equal(queries.length, 3);
});