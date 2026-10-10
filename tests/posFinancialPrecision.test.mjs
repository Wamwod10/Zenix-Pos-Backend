import test from 'node:test';
import assert from 'node:assert/strict';
import * as money from '../src/lib/posMoney.js';
test('three partial refunds consume the exact original cent total',()=>{
  assert.equal(typeof money.refundAmount,'function');
  assert.deepEqual([0,1,2].map(returned=>money.refundAmount('100.00','3.000',returned,1)),[33.33,33.34,33.33]);
});
test('fractional quantity is computed in decimal and rounded once',()=>{
  assert.equal(typeof money.lineAmount,'function');
  assert.equal(money.lineAmount('0.333','10.01',0),3.33);
  assert.equal(money.lineAmount('3','0.10',0),0.30);
});
test('last partial refund consumes legacy rounded remainder exactly',()=>{
 assert.equal(money.refundAmount('100','3','2','1','66.66'),33.34);
});
