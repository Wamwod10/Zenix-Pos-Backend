import test from 'node:test';
import assert from 'node:assert/strict';
import * as shiftCash from '../src/lib/shiftCash.js';

for (const count of [1,100,3000,5000,10000]) {
  test(`authoritative cash summary includes ${count} sales and mixed cash movements`,async()=>{
    assert.equal(typeof shiftCash.shiftCashSummary,'function');
    // PostgreSQL NUMERIC sums arrive as strings. Source rows include refunds,
    // expenses, supplier payments, customer repayments, and manual movements.
    const cashSales=(BigInt(count)*1001n);
    const movements=[{type:'out',amount:101n},{type:'out',amount:202n},{type:'out',amount:303n},{type:'in',amount:404n},{type:'in',amount:505n},{type:'out',amount:606n}];
    const cashIn=movements.filter(x=>x.type==='in').reduce((s,x)=>s+x.amount,0n);
    const cashOut=movements.filter(x=>x.type==='out').reduce((s,x)=>s+x.amount,0n);
    const decimal=cents=>`${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
    let calls=0;
    const client={query:async(sql,params)=>{
      calls++;
      assert.deepEqual(params,['shift','org']);
      assert.match(sql,/s\.organization_id=\$2/);
      assert.match(sql,/shift_movements[\s\S]*organization_id=\$2/);
      assert.doesNotMatch(sql,/LIMIT/i);
      return {rows:[{cash_sales:decimal(cashSales),cash_in:decimal(cashIn),cash_out:decimal(cashOut)}]};
    }};
    const summary=await shiftCash.shiftCashSummary(client,{id:'shift',organization_id:'org',opening_cash:'0.10'});
    assert.deepEqual(summary,{openingCash:0.1,cashSales:Number(cashSales)/100,cashIn:Number(cashIn)/100,cashOut:Number(cashOut)/100,expectedCash:Number(10n+cashSales+cashIn-cashOut)/100});
    assert.equal(calls,1,'all components use one database snapshot');
    assert.equal(await shiftCash.shiftExpectedCash(client,{id:'shift',organization_id:'org',opening_cash:'0.10'}),summary.expectedCash);
  });
}
