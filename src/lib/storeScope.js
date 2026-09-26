import { HttpError } from "./http.js";
import { ROLES } from "./permissions.js";

const BRANCH_LOCKED_ROLES=new Set([ROLES.CASHIER,ROLES.SALES,ROLES.WAREHOUSE]);

export function isBranchLocked(user){
  return Boolean(user && BRANCH_LOCKED_ROLES.has(user.appRole));
}

export function assertStoreScope(user, storeId, {allowNull=false}={}){
  if(!storeId){
    if(allowNull)return null;
    throw new HttpError(400,"Filial tanlanmagan","STORE_REQUIRED");
  }
  if(isBranchLocked(user) && !user.storeId){
    throw new HttpError(403,"Foydalanuvchi faol filialga biriktirilmagan","STORE_ASSIGNMENT_REQUIRED");
  }
  if(isBranchLocked(user) && String(user.storeId)!==String(storeId)){
    throw new HttpError(403,"Bu filial ma’lumotlariga ruxsat yo‘q","STORE_FORBIDDEN");
  }
  return storeId;
}

export async function assertOrganizationStore(client, organizationId, storeId, {activeOnly=true}={}){
  if(!storeId)throw new HttpError(400,"Filial tanlanmagan","STORE_REQUIRED");
  const {rows}=await client.query(
    `SELECT id,name,active FROM stores WHERE id=$1 AND organization_id=$2 ${activeOnly?"AND active=true":""} LIMIT 1`,
    [storeId,organizationId],
  );
  if(!rows[0])throw new HttpError(404,activeOnly?"Faol filial topilmadi":"Filial topilmadi","STORE_NOT_FOUND");
  return rows[0];
}

export function scopedStoreId(user, requestedStoreId){
  if(isBranchLocked(user)){
    if(!user.storeId)throw new HttpError(403,"Foydalanuvchi faol filialga biriktirilmagan","STORE_ASSIGNMENT_REQUIRED");
    if(requestedStoreId && String(requestedStoreId)!==String(user.storeId))throw new HttpError(403,"Bu filial ma’lumotlariga ruxsat yo‘q","STORE_FORBIDDEN");
    return user.storeId;
  }
  return requestedStoreId || null;
}
