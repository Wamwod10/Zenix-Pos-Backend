export const BILLING_PLANS=Object.freeze({
  MONTHLY:{key:"MONTHLY",label:"Oylik",amount:350_000,months:1,includedStores:2,referenceDays:30,extraStoreAmount:120_000},
  ANNUAL:{key:"ANNUAL",label:"Yillik",amount:3_300_000,months:12,includedStores:2,referenceDays:365,extraStoreAmount:1_100_000},
});

const DAY_MS=86_400_000;
const asDate=(value)=>{
  if(!value)return null;
  const raw=String(value).slice(0,10);
  const match=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!match)return null;
  const [,year,month,day]=match;
  const date=new Date(Date.UTC(Number(year),Number(month)-1,Number(day),12,0,0));
  return Number.isFinite(date.getTime())?date:null;
};
export const dateISO=(value)=>{
  const date=value instanceof Date?value:asDate(value);
  if(!date||!Number.isFinite(date.getTime()))return null;
  return date.toISOString().slice(0,10);
};
export const todayISO=()=>dateISO(new Date());
export const daysBetween=(fromValue,toValue)=>{
  const from=asDate(fromValue),to=asDate(toValue);
  if(!from||!to)return 0;
  return Math.max(0,Math.round((to.getTime()-from.getTime())/DAY_MS));
};
export const addMonths=(baseValue,months)=>{
  const base=asDate(baseValue)||new Date();
  const day=base.getUTCDate();
  const result=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth(),1,12,0,0));
  result.setUTCMonth(result.getUTCMonth()+Number(months||0));
  const lastDay=new Date(Date.UTC(result.getUTCFullYear(),result.getUTCMonth()+1,0,12,0,0)).getUTCDate();
  result.setUTCDate(Math.min(day,lastDay));
  return dateISO(result);
};
export const planExtensionPrice=(planKey,days)=>{
  const plan=BILLING_PLANS[planKey]||BILLING_PLANS.ANNUAL;
  return Math.round(Number(plan.amount)*Math.max(0,Number(days||0))/Math.max(1,Number(plan.referenceDays)));
};
export const extraStoreExtensionPrice=(planKey,days,count)=>{
  const plan=BILLING_PLANS[planKey]||BILLING_PLANS.ANNUAL;
  return Math.round(Number(plan.extraStoreAmount)*Math.max(0,Number(days||0))/Math.max(1,Number(plan.referenceDays)))*Math.max(0,Number(count||0));
};
export const makeBillingOrderId=()=>`ZX-${crypto.randomUUID().slice(0,10).toUpperCase()}`;
