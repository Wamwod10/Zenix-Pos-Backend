import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogPageQuerySchema, encodeCatalogCursor, decodeCatalogCursor } from '../src/lib/catalogCursor.js';
import { readFileSync } from 'node:fs';

test('catalog cursor retains deterministic created_at + UUID ordering',()=>{
 const token=encodeCatalogCursor({created_at:new Date('2026-10-07T08:15:30Z'),id:'00000000-0000-4000-8000-000000000008'});
 assert.deepEqual(decodeCatalogCursor(token),{createdAt:'2026-10-07T08:15:30.000Z',id:'00000000-0000-4000-8000-000000000008'});
});
test('catalog cursor rejects forged, oversized and nonsensical cursors',()=>{
 for(const str of ['%%%',Buffer.from('{}').toString('base64url'),'x'.repeat(513)])assert.throws(()=>decodeCatalogCursor(str),{code:'INVALID_CATALOG_CURSOR'});
});
test('product pages enforce bounded sizes and search without trusting arbitrary input',()=>{
 assert.equal(catalogPageQuerySchema.parse({}).limit,50);
 assert.equal(catalogPageQuerySchema.safeParse({limit:'101'}).success,false);
 assert.equal(catalogPageQuerySchema.safeParse({limit:'50',search:'a'.repeat(121)}).success,false);
});
test('paginated product query always scopes organization and branch and uses stable ordering',()=>{
 const src=readFileSync(new URL('../src/routes/products.js',import.meta.url),'utf8');
 assert.match(src,/router\.get\("\/page"/);
 assert.match(src,/p\.organization_id=\$1/);
 assert.match(src,/ib\.store_id=\$\$\{params\.length\}/);
 assert.match(src,/ORDER BY p\.created_at DESC,p\.id DESC LIMIT/);
});
