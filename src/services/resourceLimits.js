import {HttpError} from '../lib/http.js';

export const RESOURCE_KEYS=Object.freeze(['employees','stores','warehouses','registers','products','customers']);
const names={employees:'Xodimlar',stores:'Filiallar',warehouses:'Omborlar',registers:'POS kassalar',products:'Mahsulotlar',customers:'Mijozlar'};
const codes={employees:'EMPLOYEE_LIMIT',stores:'STORE_LIMIT',warehouses:'WAREHOUSE_LIMIT',registers:'REGISTER_LIMIT',products:'PRODUCT_LIMIT',customers:'CUSTOMER_LIMIT'};

export async function assertResourceCapacity(db,organizationId,resource,increase=1){
  if(!RESOURCE_KEYS.includes(resource)||!Number.isSafeInteger(increase)||increase<1)throw new HttpError(400,'Limit so‘rovi noto‘g‘ri','INVALID_RESOURCE_LIMIT_REQUEST');
  // The same database function is used by row guards, including inventory imports.
  await db.query('SELECT assert_resource_capacity($1,$2,$3)',[organizationId,resource,increase]);
}
export async function resourceEntitlements(db,organizationId){
  const row=(await db.query(`SELECT jsonb_object_agg(resource,resource_entitlement($1,resource)) AS resources
    FROM unnest($2::text[]) AS resource`,[organizationId,RESOURCE_KEYS])).rows[0];
  return row.resources;
}
export function resourceLimitFailure(error){
  let details;try{details=JSON.parse(error.detail||'null')}catch{}
  if(!details||!RESOURCE_KEYS.includes(details.resource))return {code:'PRODUCT_LIMIT',message:'Tarifdagi mahsulot limiti tugagan.'};
  return {code:codes[details.resource],message:`${names[details.resource]} limiti tugagan: ${details.used}/${details.limit}. ${details.upgradeAvailable?'Tarifni oshiring.':'Yangi resurs yaratishdan oldin foydalanishni kamaytiring.'}`,details};
}
