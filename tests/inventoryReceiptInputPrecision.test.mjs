import test from 'node:test';
import assert from 'node:assert/strict';
import {inventoryReceiptSchema} from '../src/services/inventoryReceipt.js';
import {isInventoryQuantityInput} from '../src/lib/inventoryNumeric.js';

const storeId='11111111-1111-4111-8111-111111111111';
const productId='22222222-2222-4222-8222-222222222222';
const supplierId='33333333-3333-4333-8333-333333333333';
const receipt=(quantity=0.125,paidAmount=0.10)=>({
  storeId, supplierId,
  lines:[{productId,quantity,costPrice:10.20}],
  settlement:{status:'partial',paidAmount},
});

test('receipt lines reject fractional units smaller than NUMERIC(18,3) before stock is written',()=>{
  for(const quantity of ['',null,0,0.0001,'0.0001',1.0000000001,'1.0000000001',-1,1000000000]){
    assert.equal(isInventoryQuantityInput(quantity),false,'input '+String(quantity));
    assert.equal(inventoryReceiptSchema.safeParse(receipt(quantity)).success,false,'schema '+String(quantity));
  }
  for(const quantity of [0.001,0.125,1.234,'0.125','1.000',999999999]){
    const parsed=inventoryReceiptSchema.safeParse(receipt(quantity));
    assert.equal(parsed.success,true,JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.lines[0].quantity,Number(quantity));
  }
});

test('partial supplier settlement rejects coerced empty and sub-cent payment amounts',()=>{
  for(const amount of ['',null,0.001,'0.001',127000.00000001,'127000.00000001']){
    const parsed=inventoryReceiptSchema.safeParse(receipt(1.125,amount));
    assert.equal(parsed.success,false,'invalid settlement '+String(amount));
  }
  for(const amount of [0,0.10,'0.20',127000.25]){
    const parsed=inventoryReceiptSchema.safeParse(receipt(1.125,amount));
    assert.equal(parsed.success,true,JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.settlement.paidAmount,Number(amount));
  }
  const omitted=receipt(1.125);delete omitted.settlement.paidAmount;
  assert.equal(inventoryReceiptSchema.parse(omitted).settlement.paidAmount,0);
});
