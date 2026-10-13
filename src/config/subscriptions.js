import {daysBetween} from './billing.js';
import {databaseDateISO} from '../lib/businessDate.js';
import {HttpError} from '../lib/http.js';

export const SUBSCRIPTION_PRICING_VERSION=1;
export const BILLING_TIMEZONE='Asia/Tashkent';
const makePlan=(code,label,rank,monthly,annual,limits)=>Object.freeze({code,label,rank,prices:Object.freeze({MONTHLY:monthly,ANNUAL:annual}),limits:Object.freeze(limits)});
export const SUBSCRIPTION_CATALOG=Object.freeze({1:Object.freeze({
  START:makePlan('START','Start',1,250000,2500000,{employees:2,stores:1,warehouses:1,registers:1,products:750,customers:500,aiRequests:0}),
  BUSINESS:makePlan('BUSINESS','Business',2,350000,3300000,{employees:7,stores:2,warehouses:3,registers:3,products:10000,customers:null,aiRequests:100}),
  PREMIUM:makePlan('PREMIUM','Premium',3,590000,5900000,{employees:25,stores:10,warehouses:15,registers:10,products:null,customers:null,aiRequests:500}),
})});
export const subscriptionPlan=(code,version=SUBSCRIPTION_PRICING_VERSION)=>{
  const plan=SUBSCRIPTION_CATALOG[version]?.[code];
  if(!plan)throw new HttpError(400,'Noma’lum tarif yoki narx versiyasi','INVALID_SUBSCRIPTION_PLAN');
  return plan;
};
export function moneyUnits(value){
  const raw=String(value);
  if(!/^\d{1,14}(?:\.\d{1,2})?$/.test(raw))throw new HttpError(400,'Noto‘g‘ri pul miqdori','INVALID_MONEY');
  const [whole,fraction='']=raw.split('.');
  const units=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(units>BigInt(Number.MAX_SAFE_INTEGER))throw new HttpError(400,'Pul miqdori chegaradan oshgan','INVALID_MONEY');
  return units;
}
export const moneyDecimal=units=>`${units/100n}.${String(units%100n).padStart(2,'0')}`;
export const roundRatio=(units,numerator,denominator)=>{
  if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||numerator<0||denominator<=0)throw new HttpError(400,'Noto‘g‘ri xizmat davri','INVALID_SERVICE_PERIOD');
  return (units*BigInt(numerator)+BigInt(denominator)/2n)/BigInt(denominator);
};
export function unusedTermValue(term,today){
  const start=databaseDateISO(term.starts_on),end=databaseDateISO(term.ends_on);
  const days=daysBetween(start,end);
  if(!days)throw new HttpError(409,'Obuna davri noto‘g‘ri','INVALID_SERVICE_PERIOD');
  const remaining=today<=start?days:daysBetween(today,end);
  return roundRatio(moneyUnits(term.value_amount),remaining,days);
}
