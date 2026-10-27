import {HttpError} from './http.js';
// Decimal inputs are evaluated as integer ratios; only final cents are rounded.
const ratio=value=>{
 const match=String(value).match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
 if(!match)throw new RangeError('Invalid decimal');
 const fraction=match[3]||'', exponent=Number(match[4]||0)-fraction.length;
 if(Math.abs(exponent)>30)throw new RangeError('Decimal out of range');
 let numerator=BigInt(match[2]+fraction)*(match[1]==='-'?-1n:1n),denominator=1n;
 if(exponent>=0)numerator*=10n**BigInt(exponent);else denominator=10n**BigInt(-exponent);
 return {numerator,denominator};
};
const round=(n,d)=>n<0n?-((-n+d/2n)/d):(n+d/2n)/d;
const cents=value=>{const r=ratio(value);return round(r.numerator*100n,r.denominator)};
const fromCents=value=>{if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<-BigInt(Number.MAX_SAFE_INTEGER))throw new HttpError(409,'Summa ruxsat etilgan aniq hisoblash chegarasidan oshdi.','FINANCIAL_NUMERIC_LIMIT');const absolute=value<0n?-value:value;return exactDecimalNumber(`${value<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`)};
export const roundMoney=value=>fromCents(cents(value));
export const sumMoney=values=>fromCents(values.reduce((sum,value)=>sum+cents(value),0n));
export const lineAmount=(quantity,unitPrice,discount=0)=>{
 const q=ratio(quantity),p=ratio(unitPrice),d=ratio(discount);
 return fromCents(round(q.numerator*p.numerator*(100n*d.denominator-d.numerator),q.denominator*p.denominator*d.denominator));
};
export const refundAmount=(lineTotal,soldQuantity,returnedQuantity,quantity,alreadyRefunded)=>{
 const sold=ratio(soldQuantity),before=ratio(returnedQuantity),q=ratio(quantity);
 if(sold.numerator<=0n||q.numerator<=0n||before.numerator<0n)throw new RangeError('Invalid refund quantity');
 const endN=before.numerator*q.denominator+q.numerator*before.denominator,endD=before.denominator*q.denominator;
 if(endN*sold.denominator>sold.numerator*endD)throw new RangeError('Refund exceeds sold quantity');
 const total=cents(lineTotal);
 const previous=alreadyRefunded===undefined?round(total*before.numerator*sold.denominator,before.denominator*sold.numerator):cents(alreadyRefunded);
 const next=round(total*endN*sold.denominator,endD*sold.numerator);
 if(next<previous||previous>total)throw new RangeError('Historical refund exceeds allocation');
 return fromCents(next-previous);
};

const precisionError=()=>new HttpError(409,'Moliyaviy qiymat aniq ko‘rsatiladigan chegaradan oshdi. Hisobni tekshiring.','FINANCIAL_PRECISION_REVIEW_REQUIRED');
// Keep the existing numeric API shape only when its decimal JSON value is exact.
// Large values must be reviewed instead of silently losing cents in Number().
export const exactDecimalNumber=value=>{
 try{
  const r=ratio(value??0),n=Number(value??0),back=ratio(n);
  const absolute=r.numerator<0n?-r.numerator:r.numerator;
  if(!Number.isFinite(n)||absolute*100n>BigInt(Number.MAX_SAFE_INTEGER)*r.denominator||r.numerator*back.denominator!==back.numerator*r.denominator)throw precisionError();
  return n;
 }catch{throw precisionError()}
};
export const sumExactDecimals=values=>{
 const ratios=values.map(value=>ratio(value??0));
 const denominator=ratios.reduce((max,r)=>r.denominator>max?r.denominator:max,1n);
 const numerator=ratios.reduce((sum,r)=>sum+r.numerator*(denominator/r.denominator),0n);
 const negative=numerator<0n,absolute=negative?-numerator:numerator;
 const digits=denominator.toString().length-1;
 const decimal=digits?`${absolute/denominator}.${String(absolute%denominator).padStart(digits,'0')}`:String(absolute);
 return exactDecimalNumber(`${negative?'-':''}${decimal}`);
};
export const isMoneyInput=value=>{
 try{const r=ratio(value);return r.numerator>=0n&&r.numerator<=9000000000000n*r.denominator&&(r.numerator*100n)%r.denominator===0n}catch{return false}
};
