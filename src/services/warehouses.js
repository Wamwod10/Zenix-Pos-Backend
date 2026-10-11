import {HttpError} from '../lib/http.js';

export async function setInventoryWarehouse(db,{organizationId,storeId,warehouseId}){
  if(!warehouseId)return;
  const row=(await db.query('SELECT id FROM warehouses WHERE organization_id=$1 AND store_id=$2 AND id=$3 AND active=true FOR SHARE',[organizationId,storeId,warehouseId])).rows[0];
  if(!row)throw new HttpError(404,'Ombor ushbu filialda topilmadi','WAREHOUSE_NOT_FOUND');
  await db.query("SELECT set_config('zenix.inventory_warehouse',$1,true)",[warehouseId]);
}
