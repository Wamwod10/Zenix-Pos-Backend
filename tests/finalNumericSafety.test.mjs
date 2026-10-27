import test from 'node:test';
import assert from 'node:assert/strict';
import * as money from '../src/lib/posMoney.js';
import {inventoryReceiptSchema} from '../src/services/inventoryReceipt.js';
import {errorHandler} from '../src/middleware/error.js';
import {assertInventoryAddition} from '../src/lib/inventoryNumeric.js';
import {mapBootstrapProduct} from '../src/lib/posCatalog.js';

test('NUMERIC(18,3)/(18,2) limits retain zero and reject overflow before mutation',()=>{
 assert.doesNotThrow(()=>assertInventoryAddition({quantity:'999999999999999.998',avg_cost:'9999999999999999.99'},'0.001','0'));
 for(const [quantity,cost] of [['0.002','0'],['0.001','10000000000000000.00'],['0.0001','0'],['1',null]])assert.throws(()=>assertInventoryAddition({quantity:'999999999999999.998',avg_cost:'0.00'},quantity,cost),e=>e.code==='INVENTORY_NUMERIC_LIMIT');
 assert.deepEqual(mapBootstrapProduct({cost_by_store:{a:'0.00'},stock_by_store:{a:'0.125'}}).stockByStore,{a:0.125});
 assert.throws(()=>mapBootstrapProduct({cost_by_store:{a:'9999999999999999.99'}}),e=>e.code==='FINANCIAL_PRECISION_REVIEW_REQUIRED');
});

test('report decimal conversion rejects loss and exact arithmetic preserves cancellation',()=>{
 assert.throws(()=>money.lineAmount('999999999','9000000000000'),e=>e.status===409&&e.code==='FINANCIAL_NUMERIC_LIMIT');
 assert.equal(typeof money.exactDecimalNumber,'function');
 assert.equal(money.exactDecimalNumber('0.12345'),0.12345);
 assert.equal(money.sumExactDecimals(['0.1','0.2','-0.3']),0);
 assert.equal(money.sumExactDecimals(['100.00001','-100','-0.00001']),0);
 for(const value of ['9999999999999999.99','90071992547409.93','NaN'])assert.throws(()=>money.exactDecimalNumber(value),e=>e.code==='FINANCIAL_PRECISION_REVIEW_REQUIRED');
});
test('inventory receipt preserves positive-cost contract and rejects invalid cost domain',()=>{
 const base={storeId:'00000000-0000-4000-8000-000000000001',lines:[{name:'Free item',quantity:1,costPrice:1}]};
 assert.equal(inventoryReceiptSchema.safeParse(base).success,true);
 for(const costPrice of [0,-1,1e16,0.001,Infinity])assert.equal(inventoryReceiptSchema.safeParse({...base,lines:[{...base.lines[0],costPrice}]}).success,false);
});
test('unrelated PostgreSQL numeric/server errors remain server errors',()=>{
 let status,payload;const res={status(v){status=v;return this},json(v){payload=v}};
 const original=console.error;console.error=()=>{};
 try{errorHandler(Object.assign(new Error('unexpected query overflow'),{code:'22003'}),{method:'GET'},res,()=>{})}finally{console.error=original}
 assert.equal(status,500);assert.equal(payload.error.code,'INTERNAL_ERROR');
});
