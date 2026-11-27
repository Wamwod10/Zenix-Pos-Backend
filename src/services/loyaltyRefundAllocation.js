// Cumulative monetary allocation, separate from points conversion and ledger writes.
// Original tender only. Credit sales and manual cash-out are deliberately excluded.
// Persist the original tender snapshot; never recompute from today's policy.
import {isMoneyInput,exactDecimalNumber} from '../lib/posMoney.js';
const toCents=v=>{
 if(!isMoneyInput(v))throw new RangeError('Invalid refund money');
 return BigInt(exactDecimalNumber(v).toFixed(2).replace('.',''));
};
const asMoney=n=>exactDecimalNumber(`${n/100n}.${String(n%100n).padStart(2,'0')}`);
export function allocateLoyaltyRefund({total,loyaltyAmount,previousReturned,returnAmount}){
 const t=toCents(total),l=toCents(loyaltyAmount),p=toCents(previousReturned),a=toCents(returnAmount);
 if(t===0n||l>t||p>t||a===0n||p+a>t)throw new RangeError('Refund exceeds original sale');
 // Floor cumulative noncash share; residual cents stay in monetary tender.
 // Differences telescope exactly; full return never pays out loyalty as cash.
 const before=p*l/t,after=(p+a)*l/t,noncash=after-before,cash=a-noncash;
 return {loyaltyAmount:asMoney(noncash),monetaryAmount:asMoney(cash),cumulativeLoyaltyAmount:asMoney(after),cumulativeMonetaryAmount:asMoney(p+a-after)};
}
