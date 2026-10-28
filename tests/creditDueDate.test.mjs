import test from 'node:test';
import assert from 'node:assert/strict';
import {isValidCalendarDateISO,isAcceptableCreditDueDate} from '../src/lib/creditDueDate.js';

test('strict date-only validation rejects impossible and alternate-form dates',()=>{
 for(const value of [null,'','2026-02-30','2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-01-00','2026-1-01','0000-01-01','2026-10-28T00:00:00Z','28-10-2026']){
  assert.equal(isValidCalendarDateISO(value),false,String(value));
 }
 for(const value of ['2024-02-29','2026-10-28','2026-12-31','2028-02-29']){
  assert.equal(isValidCalendarDateISO(value),true,value);
 }
});

test('credit due date uses organization-local calendar day, not host clock',()=>{
 const today='2026-10-28';
 assert.equal(isAcceptableCreditDueDate('2026-10-27',today),false);
 assert.equal(isAcceptableCreditDueDate(today,today),true);
 assert.equal(isAcceptableCreditDueDate('2026-10-29',today),true);
 assert.equal(isAcceptableCreditDueDate('2026-11-01',today),true);
 assert.equal(isAcceptableCreditDueDate('2026-02-30',today),false);
 assert.equal(isAcceptableCreditDueDate('2099-01-01','invalid'),false);
});
