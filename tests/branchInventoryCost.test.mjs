import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mapBootstrapProduct} from '../src/lib/posCatalog.js';
test('catalog preserves branch zero cost independently from product reference',()=>{
 const p=mapBootstrapProduct({cost_price:99,cost_by_store:{a:0,b:15},stock_by_store:{a:10,b:20}});
 assert.deepEqual(p.costByStore,{a:0,b:15});assert.equal(p.costPrice,99);
});
test('prospective receipt and sale costs preserve zero balance cost',()=>{
 for(const file of ['../src/services/inventoryReceipt.js','../src/routes/sales.js']){
 const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');assert.doesNotMatch(source,/balance\.avg_cost\|\|/);assert.match(source,/balance\.avg_cost\?\?/);
 }
});
test('zero-cost receipt opening balance is not repriced by another branch reference',()=>{
 const source=fs.readFileSync(new URL('../src/services/inventoryReceipt.js',import.meta.url),'utf8');
 const expression=source.match(/oldCost=Number\(([^)]+)\)/)[1];
 const oldCost=Function('balance','product',`return Number(${expression})`)({avg_cost:0},{cost_price:99});
 assert.equal(oldCost,0);assert.equal((10*oldCost+10*20)/20,10);
});
test('receipt image attachment is validated before product creation and respects existing binding',()=>{
 const source=fs.readFileSync(new URL('../src/services/inventoryReceipt.js',import.meta.url),'utf8');
 assert.match(source,/hasOwnProperty.call\(line.metadata\|\|\{\},'imageKey'\).*assertFileAssetBinding/);
 assert.match(source,/existingId:product\?\.metadata\?\.imageKey/);
 assert.ok(source.indexOf('await assertFileAssetBinding')<source.indexOf('INSERT INTO products'));
});
