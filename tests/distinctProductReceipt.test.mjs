import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inventoryReceiptSchema} from '../src/services/inventoryReceipt.js';
const base={storeId:'11111111-1111-4111-8111-111111111111'};
const row={name:'Cola',quantity:2,costPrice:1000,sellPrice:1500,createNew:true};
test('same-name new variants have distinct explicit identities; legacy receipts remain compatible',()=>{
 const one={...row,sku:'BC-2900000000001',barcode:'2900000000001'},two={...row,sku:'BC-2900000000002',barcode:'2900000000002',sellPrice:3000,unit:'litr'};
 const parsed=inventoryReceiptSchema.parse({...base,lines:[one,two]});
 assert.equal(parsed.lines.length,2);assert.notEqual(parsed.lines[0].barcode,parsed.lines[1].barcode);
 assert.equal(inventoryReceiptSchema.safeParse({...base,lines:[row]}).success,false);
 assert.equal(inventoryReceiptSchema.safeParse({...base,lines:[{...one,productId:'22222222-2222-4222-8222-222222222222'}]}).success,false);
 const legacy=inventoryReceiptSchema.parse({...base,lines:[{name:'Cola',quantity:2,costPrice:1000}]});
 assert.equal(Object.hasOwn(legacy.lines[0],'createNew'),false,'old replay fingerprint must not change');
});
test('explicit create-new barcode collision is rejected before existing stock is used',()=>{
 const src=readFileSync(new URL('../src/services/inventoryReceipt.js',import.meta.url),'utf8');
 assert.match(src,/if\(product&&line\.createNew\)throw new HttpError\(409,[^\n]+PRODUCT_BARCODE_EXISTS/);
 assert.ok(src.indexOf("PRODUCT_BARCODE_EXISTS")<src.indexOf("const serials="));
});
