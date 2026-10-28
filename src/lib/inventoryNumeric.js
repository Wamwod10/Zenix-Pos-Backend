import {HttpError} from './http.js';

const limit=999999999999999999n;
// Raw receipt quantities must match NUMERIC(18,3) exactly before Number()
// conversion. Do not accept 0.0000001 and silently post 0.000 to stock.
export function isInventoryQuantityInput(value,{allowZero=false,allowNegative=false}={}){
 if(!['string','number'].includes(typeof value))return false;
 const raw=String(value).trim();
 if(!(allowNegative?/^-?\d+(?:\.\d{1,3})?$/:/^\d+(?:\.\d{1,3})?$/).test(raw))return false;
 const negative=raw.startsWith('-'),positive=negative?raw.slice(1):raw;
 const [whole,fraction='']=positive.split('.');
 const units=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
 return (allowZero||units>0n)&&units<=999999999000n;
}
const scaled=(value,scale)=>{
 const match=String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
 if(!match||(match[3]||'').length>scale)throw new HttpError(409,'Ombor qiymati yoki miqdori aniqligini tekshiring.','INVENTORY_NUMERIC_LIMIT');
 const units=BigInt(match[2])*10n**BigInt(scale)+BigInt((match[3]||'').padEnd(scale,'0'));
 return match[1]?-units:units;
};
// Derive UI/audit/stock-movement snapshot balances in exact thousandths.
// Native JS 10.2 + 0.1 can become 10.299999999999999; PostgreSQL stores
// NUMERIC(18,3), so keep the same canonical decimal at every layer.
export function sumInventoryQuantity(values){
 const units=values.reduce((sum,value)=>sum+scaled(value,3),0n);
 const absolute=units<0n?-units:units;
 if(absolute>limit||absolute>BigInt(Number.MAX_SAFE_INTEGER))throw new HttpError(409,'Ombor miqdori aniq hisoblash chegarasidan oshadi.','INVENTORY_NUMERIC_LIMIT');
 return Number(`${units<0n?'-':''}${absolute/1000n}.${String(absolute%1000n).padStart(3,'0')}`);
}
// Called on the locked balance before tracking or monetary mutations. PostgreSQL
// remains authoritative for weighted average and its existing NUMERIC rounding.
export function assertInventoryAddition(balance,quantity,unitCost){
 const before=scaled(balance.quantity,3),incoming=scaled(quantity,3),cost=scaled(unitCost,2),oldCost=scaled(balance.avg_cost,2);
 if(before<0n)throw new HttpError(409,'Manfiy qoldiq tannarxini tekshirish kerak.','NEGATIVE_COST_BALANCE');
 if(incoming<0n||before+incoming>limit||cost<0n||cost>limit||oldCost<0n||oldCost>limit)throw new HttpError(409,'Ombor miqdori yoki tannarxi ruxsat etilgan chegaradan oshadi.','INVENTORY_NUMERIC_LIMIT');
}
