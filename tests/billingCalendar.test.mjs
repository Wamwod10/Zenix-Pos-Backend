import test from 'node:test';
import assert from 'node:assert/strict';
import { dateISO, daysBetween, addMonths } from '../src/config/billing.js';

test('billing calendar rejects impossible dates instead of silently normalizing them',()=>{
  for(const invalid of ['2026-02-29','2026-02-31','2026-13-01','2026-00-10','2026-04-31']){
    assert.equal(dateISO(invalid),null,invalid);
    assert.equal(daysBetween('2026-01-01',invalid),0,invalid);
  }
  assert.equal(dateISO('2028-02-29'),'2028-02-29');
});

test('billing month extension preserves month-end semantics for valid dates',()=>{
  assert.equal(addMonths('2026-01-31',1),'2026-02-28');
  assert.equal(addMonths('2028-01-31',1),'2028-02-29');
});
