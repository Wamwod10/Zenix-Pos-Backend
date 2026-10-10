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
const fromCents=value=>{if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<-BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Money out of range');return Number(value)/100};
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
