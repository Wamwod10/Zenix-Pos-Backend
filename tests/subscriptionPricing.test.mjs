import test from 'node:test';
import assert from 'node:assert/strict';
const billing = await import('../src/config/subscriptions.js').catch(()=>({}));

test('three versioned tariffs price monthly/annual independently and Start has 750 products',()=>{
  assert.equal(typeof billing.subscriptionPlan,'function');
  for(const [code,monthly,annual,products] of [['START',250000,2500000,750],['BUSINESS',350000,3300000,10000],['PREMIUM',590000,5900000,null]]){
    const plan=billing.subscriptionPlan(code,1);
    assert.equal(plan.prices.MONTHLY,monthly);assert.equal(plan.prices.ANNUAL,annual);
    assert.equal(plan.limits.products,products);
  }
  assert.throws(()=>billing.subscriptionPlan('LIFETIME',1));
  assert.throws(()=>billing.subscriptionPlan('START',999));
});
test('unused value uses the actual calendar term and exact half-up tiyin arithmetic',()=>{
  assert.equal(typeof billing.unusedTermValue,'function');
  assert.equal(billing.unusedTermValue({starts_on:'2026-02-01',ends_on:'2026-03-01',value_amount:'250000.00'},'2026-02-15'),12500000n);
  assert.equal(billing.unusedTermValue({starts_on:'2024-01-01',ends_on:'2025-01-01',value_amount:'366.00'},'2024-07-02'),18300n);
  assert.equal(billing.unusedTermValue({starts_on:'2026-01-01',ends_on:'2026-01-04',value_amount:'0.01'},'2026-01-02'),1n);
  assert.equal(billing.unusedTermValue({starts_on:'2026-01-01',ends_on:'2026-02-01',value_amount:'0.00'},'2026-01-10'),0n);
});
test('money parsing rejects fractional tiyin and unsafe/negative values',()=>{
  assert.equal(typeof billing.moneyUnits,'function');
  assert.equal(billing.moneyUnits('5900000.00'),590000000n);
  assert.equal(billing.moneyDecimal(12500001n),'125000.01');
  for(const value of ['NaN','-1','1.001','9007199254740993'])assert.throws(()=>billing.moneyUnits(value));
});
test('modern promotion preserves fractional credit while legacy quotes retain whole-so‘m discounts',async()=>{
  const promos=await import('../src/services/promoCodes.js');
  assert.equal(typeof promos.subscriptionDiscountForAmount,'function');
  for(const value of ['0.35','0.65','240000.60'])assert.equal(promos.subscriptionDiscountForAmount(value,100),Number(value));
  assert.equal(promos.subscriptionDiscountForAmount('0.65',50),0.33);
  assert.equal(promos.discountForAmount('0.65',100),1);
});
