// Pure evaluation of server-loaded rules and authoritative base prices.
// Same-SKU whole-unit offers only; no stacking or mutation. Caller must use
// tenant-scoped catalog/rules, server time, and enforce checkout/refund contract.
import {isMoneyInput,exactDecimalNumber} from '../lib/posMoney.js';
const int=(n,max)=>Number.isSafeInteger(n)&&n>0&&n<=max;
const money=n=>exactDecimalNumber(`${n/100n}.${String(n%100n).padStart(2,'0')}`);
const cents=v=>{if(!isMoneyInput(v))throw new RangeError('Invalid unit price');return BigInt(exactDecimalNumber(v).toFixed(2).replace('.',''))};
function timestamp(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s))throw new RangeError('Use UTC ISO timestamp');const n=Date.parse(s);if(!Number.isFinite(n)||new Date(n).toISOString().replace('.000Z','Z')!==s.replace('.000Z','Z'))throw new RangeError('Invalid timestamp');return n}
export function evaluateProductPromotion({line,rules,storeId,now}){
 const t=timestamp(now);
 if(!Array.isArray(rules)||rules.length>200)throw new RangeError('Invalid rules');
 if(!line||!line.productId||!storeId)throw new RangeError('Missing product or store');
 if(line.unit!=='dona'||!int(line.quantity,1000000)||line.hasManualDiscount||line.isPackaged)return null;
 const p=cents(line.unitPrice),qty=BigInt(line.quantity),gross=p*qty;
 if(gross>900000000000000n)throw new RangeError('Sale amount out of range');
 let best=null;
 const ids=new Set();
 for(const rule of rules){
  if(typeof rule?.id!=='string'||!rule.id||ids.has(rule.id))throw new RangeError('Invalid or duplicate rule ID');
  ids.add(rule.id);
  if(rule.enabled!==true||rule.productId!==line.productId)continue;
  if(!Array.isArray(rule.storeIds)||rule.storeIds.some(x=>typeof x!=='string'||!x))throw new RangeError('Invalid store scope');
  if(rule.storeIds.length&&!rule.storeIds.includes(storeId))continue;
  const start=timestamp(rule.startsAt),end=timestamp(rule.endsAt);
  if(start>=end)throw new RangeError('Invalid promotion dates');
  if(t<start||t>=end)continue;
  let discount=0n,freeUnits=0;
  if(rule.kind==='BUY_GET'){
   if(!int(rule.buy,1000)||!int(rule.free,1000)||!int(rule.maxGroups,1000000))throw new RangeError('Invalid buy/get rule');
   const groups=Math.min(Math.floor(line.quantity/(rule.buy+rule.free)),rule.maxGroups);
   freeUnits=groups*rule.free;discount=BigInt(freeUnits)*p;
  }else if(rule.kind==='QUANTITY_PERCENT'){
   if(!int(rule.minQuantity,1000000)||!int(rule.discountBps,10000))throw new RangeError('Invalid quantity rule');
   if(line.quantity>=rule.minQuantity)discount=(gross*BigInt(rule.discountBps)+5000n)/10000n;
  }else throw new RangeError('Unknown promotion type');
  if(discount>0n&&(!best||discount>best.discount||(discount===best.discount&&rule.id<best.id)))best={id:rule.id,kind:rule.kind,discount,freeUnits};
 }
 return best?{ruleId:best.id,kind:best.kind,freeUnits:best.freeUnits,gross:money(gross),discount:money(best.discount),net:money(gross-best.discount)}:null;
}
