import test from 'node:test';
import assert from 'node:assert/strict';
import { addCatalogSearchFilter, catalogSearchPattern } from '../src/lib/catalogSearch.js';

test('literal catalog search escapes PostgreSQL LIKE wildcards and backslashes', () => {
  assert.equal(catalogSearchPattern('Cola'), '%Cola%');
  assert.equal(catalogSearchPattern('30%_s\\'), '%30\\%\\_s\\\\%');
});
test('catalog page searches brand/category as the UI promises and checks barcodes exactly', () => {
  const params=['tenant-uuid'];
  const filter=addCatalogSearchFilter(params,'30%');
  assert.deepEqual(params,['tenant-uuid','%30\\%%','30%']);
  for(const field of ['p.name','p.sku','p.brand','p.category'])assert.match(filter,new RegExp(field.replace('.','\\.')+' ILIKE'));
  assert.match(filter,/p\.barcode=\$3/);
  assert.match(filter,/ESCAPE '\\'/);
  assert.equal(addCatalogSearchFilter(params,''),null);
});
