// Pure quote only: no ledger writes, payment methods or activation.
// All rates are explicit owner policy; callers must load them and the balance server-side.
import {isMoneyInput,exactDecimalNumber} from '../lib/posMoney.js';
const safePositive=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
function cents(value){
 if(!isMoneyInput(value))throw new RangeError('Invalid sale total');
 return BigInt(exactDecimalNumber(value).toFixed(2).replace('.',''));
}
function wholeBalance(value){
 const raw=String(value);
 if(!/^-?\d+(?:\.\d+)?$/.test(raw)||raw.length>40)throw new RangeError('Invalid ledger balance');
 if(raw.startsWith('-'))return 0n;
 return BigInt(raw.split('.')[0]);
}
const min=(a,b)=>a<b?a:b;
const money=n=>exactDecimalNumber(`${n/100n}.${String(n%100n).padStart(2,'0')}`);
export function quoteLoyaltyRedemption({policy,total,balance,requestedPoints=0}){
 const totalCents=cents(total);
 if(policy?.enabled!==true)return {enabled:false,maxPoints:0,points:0,amount:0,remaining:money(totalCents)};
 if(!safePositive(policy.valuePerPoint,1000000)||!safePositive(policy.maxShareBps,10000))throw new RangeError('Invalid redemption policy');
 if(!Number.isSafeInteger(requestedPoints)||requestedPoints<0)throw new RangeError('Invalid requested points');
 const rate=BigInt(policy.valuePerPoint)*100n;
 const cap=totalCents*BigInt(policy.maxShareBps)/10000n;
 const maxPoints=min(wholeBalance(balance),cap/rate);
 if(BigInt(requestedPoints)>maxPoints)throw new RangeError('Requested points exceed available redemption');
 const redeemed=BigInt(requestedPoints)*rate;
 return {enabled:true,maxPoints:Number(maxPoints),points:requestedPoints,amount:money(redeemed),remaining:money(totalCents-redeemed)};
}
