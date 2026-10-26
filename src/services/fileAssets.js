import {HttpError} from '../lib/http.js';
import {hasPermission} from '../lib/permissions.js';
import {z} from 'zod';
import {assertStoreScope} from '../lib/storeScope.js';

export function assertFilePurposeWrite(user,purpose){
  if(!['product','expense'].includes(purpose))throw new HttpError(400,'File purpose must be product or expense','FILE_PURPOSE_REQUIRED');
  if(!hasPermission(user,purpose==='product'?'productWrite':'expensesWrite'))throw new HttpError(403,'File purpose permission required','FORBIDDEN');
}
export async function findFileAsset(client,{organizationId,id,lock=false,content=false}){
  z.string().uuid().parse(id);
  // References must be read in a fresh statement after any row-lock wait:
  // another attachment may have committed while this transaction waited.
  if(lock){
    const locked=await client.query('SELECT id FROM file_assets WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,organizationId]);
    if(!locked.rowCount)throw new HttpError(404,'File not found','FILE_NOT_FOUND');
  }
  const row=(await client.query(`SELECT f.id,f.organization_id,f.uploaded_by,f.purpose,f.file_name,f.mime_type,f.file_size${content?',f.content':''},
    EXISTS(SELECT 1 FROM products p WHERE p.organization_id=f.organization_id AND p.metadata->>'imageKey'=f.id::text) product_reference,
    EXISTS(SELECT 1 FROM expenses e WHERE e.organization_id=f.organization_id AND e.metadata->>'receiptKey'=f.id::text) expense_reference
    ,ARRAY(SELECT DISTINCT e.store_id FROM expenses e WHERE e.organization_id=f.organization_id AND e.metadata->>'receiptKey'=f.id::text) expense_store_ids
    FROM file_assets f WHERE f.id=$1 AND f.organization_id=$2`,[id,organizationId])).rows[0];
  if(!row)throw new HttpError(404,'File not found','FILE_NOT_FOUND');
  return row;
}
const purposes=row=>[...new Set([row.purpose,row.product_reference?'product':null,row.expense_reference?'expense':null].filter(Boolean))];
const controls=(user,row)=>String(row.uploaded_by)===String(user.id)||hasPermission(user,'settingsWrite');
const assertExpenseScope=(user,row)=>{for(const storeId of row.expense_store_ids||[])assertStoreScope(user,storeId);};
export function assertFileAssetRead(user,row){
  assertExpenseScope(user,row);
  const linked=row.product_reference||row.expense_reference;
  if(!linked&&!controls(user,row))throw new HttpError(403,'Unlinked file belongs to another uploader','FILE_OWNER_REQUIRED');
  for(const purpose of purposes(row)){
    const allowed=purpose==='expense'
      ?hasPermission(user,'moduleExpenses')||hasPermission(user,'expensesWrite')
      :hasPermission(user,'moduleProducts')||hasPermission(user,'productWrite')||(row.product_reference&&(hasPermission(user,'moduleSales')||hasPermission(user,'moduleInventory')));
    if(!allowed)throw new HttpError(403,'File purpose permission required','FORBIDDEN');
  }
}
export async function assertFileAssetBinding(client,{user,id,purpose,existingId=null}){
  if(id===undefined||id===null||id==='')return;
  if(typeof id!=='string')throw new HttpError(400,'Invalid file identifier','FILE_ID_INVALID');
  assertFilePurposeWrite(user,purpose);
  const row=await findFileAsset(client,{organizationId:user.organizationId,id,lock:true});
  assertExpenseScope(user,row);
  if(purposes(row).some(value=>value!==purpose))throw new HttpError(409,'File purpose does not match attachment','FILE_PURPOSE_MISMATCH');
  if(id!==existingId&&!controls(user,row))throw new HttpError(403,'Only the uploader or an administrator can attach this file','FILE_OWNER_REQUIRED');
  return row;
}
export function assertFileAssetDelete(user,row){
  assertExpenseScope(user,row);
  if(!controls(user,row))throw new HttpError(403,'Only the uploader or an administrator can delete this file','FILE_OWNER_REQUIRED');
  for(const purpose of purposes(row))assertFilePurposeWrite(user,purpose);
  if(!purposes(row).length&&!hasPermission(user,'productWrite')&&!hasPermission(user,'expensesWrite'))throw new HttpError(403,'File write permission required','FORBIDDEN');
}
