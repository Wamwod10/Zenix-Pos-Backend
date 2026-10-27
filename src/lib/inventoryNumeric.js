import {HttpError} from './http.js';

const limit=999999999999999999n;
const scaled=(value,scale)=>{
 const match=String(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
 if(!match||(match[3]||'').length>scale)throw new HttpError(409,'Ombor qiymati yoki miqdori aniqligini tekshiring.','INVENTORY_NUMERIC_LIMIT');
 const units=BigInt(match[2])*10n**BigInt(scale)+BigInt((match[3]||'').padEnd(scale,'0'));
 return match[1]?-units:units;
};
// Called on the locked balance before tracking or monetary mutations. PostgreSQL
// remains authoritative for weighted average and its existing NUMERIC rounding.
export function assertInventoryAddition(balance,quantity,unitCost){
 const before=scaled(balance.quantity,3),incoming=scaled(quantity,3),cost=scaled(unitCost,2),oldCost=scaled(balance.avg_cost,2);
 if(before<0n)throw new HttpError(409,'Manfiy qoldiq tannarxini tekshirish kerak.','NEGATIVE_COST_BALANCE');
 if(incoming<0n||before+incoming>limit||cost<0n||cost>limit||oldCost<0n||oldCost>limit)throw new HttpError(409,'Ombor miqdori yoki tannarxi ruxsat etilgan chegaradan oshadi.','INVENTORY_NUMERIC_LIMIT');
}
