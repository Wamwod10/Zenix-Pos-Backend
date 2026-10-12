import {randomUUID} from 'node:crypto';
import {HttpError} from '../lib/http.js';
import {assertOrganizationStore} from '../lib/storeScope.js';
import {branchRegisterKey} from '../lib/branchShift.js';

export async function createRegister(client,{organizationId,storeId,name,active=true}){
  await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[organizationId]);
  await assertOrganizationStore(client,organizationId,storeId);
  const existing=await client.query('SELECT id FROM pos_registers WHERE organization_id=$1 AND store_id=$2 AND is_default=true',[organizationId,storeId]);
  const id=randomUUID(),isDefault=!existing.rowCount;
  return (await client.query(`INSERT INTO pos_registers(id,organization_id,store_id,name,register_key,is_default,active)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,organizationId,storeId,name,isDefault?branchRegisterKey(storeId):`pos:${id}`,isDefault,active])).rows[0];
}
export async function resolveShiftRegister(client,{organizationId,storeId,registerId}){
  let row=(await client.query(`SELECT * FROM pos_registers WHERE organization_id=$1 AND store_id=$2 AND ${registerId?'id=$3':'is_default=true'}`,
    registerId?[organizationId,storeId,registerId]:[organizationId,storeId])).rows[0];
  if(!row&&registerId)throw new HttpError(404,'POS kassa topilmadi','REGISTER_NOT_FOUND');
  if(!row)row=await createRegister(client,{organizationId,storeId,name:'Asosiy POS kassa'});
  if(!row.active)throw new HttpError(409,'POS kassa faol emas','REGISTER_INACTIVE');
  return row;
}
