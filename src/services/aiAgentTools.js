import {z} from 'zod';
import {withTransaction} from '../db/tx.js';
import {HttpError} from '../lib/http.js';
import {scopedStoreId,assertOrganizationStore} from '../lib/storeScope.js';
import {authorizationKey} from './aiPolicy.js';
import {validateProductMetadata} from '../lib/productOptions.js';
import {assertAgentEnabled,assertAgentPermission,recheckAgentActor,requireAgentReservation} from './aiAgentActor.js';
import {loadReceiptEntities,prepareAgentAction} from './aiAgentActions.js';
const id=z.string().uuid();
const optionalId=id.nullable().optional();
const quantity=z.number().positive().max(999999999).refine(n=>Math.abs(n*1000-Math.round(n*1000))<0.000001,'Miqdor 3 kasr xonadan oshmasin');
export const AGENT_TOOL_SCHEMAS=Object.freeze({
 search_products:z.object({query:z.string().trim().min(1).max(120)}).strict(),
 list_locations:z.object({}).strict(),
 get_product_stock:z.object({productId:id,storeId:optionalId,warehouseId:optionalId}).strict(),
 prepare_stock_receipt:z.object({productId:optionalId,storeId:optionalId,warehouseId:optionalId,quantity:quantity.nullable().optional(),unit:z.string().trim().min(1).max(40).nullable().optional(),costPrice:z.number().positive().max(1000000000000).refine(n=>Math.abs(n*100-Math.round(n*100))<0.000001,'Tannarx 2 kasr xonadan oshmasin').nullable().optional(),batchNo:z.string().trim().max(120).nullable().optional(),expiryDate:z.string().date().nullable().optional()}).strict(),
});
export function normalizeAgentUnit(unit){const s=String(unit||'').normalize('NFKC').trim().toLowerCase();return ['kg','kilo','kilogram','kilograms','kilogramm'].includes(s)?'kg':s}
const clarification=(message,fields,extra={})=>({kind:'clarification',message,fields,...extra});
export function validateAgentReceipt(input,product){
 const fields=['productId','storeId','warehouseId','quantity','unit','costPrice'].filter(k=>input[k]===null||input[k]===undefined);
 if(fields.length)return clarification('Kirim uchun yetishmayotgan ma’lumotlarni kiriting.',fields);
 if(normalizeAgentUnit(input.unit)!==normalizeAgentUnit(product.unit))return clarification(`Mahsulot birligi: ${product.unit}. Miqdorni shu birlikda kiriting.`,['unit','quantity'],{expectedUnit:product.unit});
 if(input.quantity*input.costPrice>1000000000000)throw new HttpError(400,'Kirim summasi chegaradan oshgan','AI_RECEIPT_LIMIT');
 const metadata=validateProductMetadata(product.metadata||{});
 if(['serial','imei'].includes(metadata.trackingMode))return clarification('Serial/IMEI mahsulotlari uchun odatiy kirim oynasida har bir birlikni kiriting.',['serials'],{code:'AI_SERIAL_UNSUPPORTED'});
 if(metadata.lotTracking&&!input.batchNo)return clarification('Partiya raqamini kiriting.',['batchNo']);
 if((metadata.expiryTracking||metadata.expiryRequired||metadata.expiryDate)&&!input.expiryDate)return clarification('Yangi partiyaning yaroqlilik sanasini kiriting.',['expiryDate']);
 // Existing batch dates describe old stock, and must never become this new lot’s dates.
 validateProductMetadata({expiryDate:input.expiryDate});
 return null;
}
export async function runAgentTool(user,name,args,{settings,requestId,conversationId}={}){
 assertAgentEnabled(settings);
 const schema=AGENT_TOOL_SCHEMAS[name];if(!schema)throw new HttpError(400,'AI vositasi mavjud emas','AI_TOOL_UNSUPPORTED');
 const input=schema.parse(args);
 if(name==='prepare_stock_receipt')assertAgentEnabled(settings,{write:true});
 return withTransaction(async db=>{
  const current=await recheckAgentActor(db,user);
  if(name==='search_products'){
   assertAgentPermission(current,'moduleProducts');
   const query=input.query.replace(/[\\%_]/g,'\\$&');
   const rows=(await db.query(`SELECT id,name,sku,barcode,unit FROM products WHERE organization_id=$1 AND archived=false AND (name ILIKE $2 OR sku ILIKE $2 OR barcode ILIKE $2) ORDER BY name,id LIMIT 21`,[user.organizationId,`%${query}%`])).rows;
   return {kind:'products',candidates:rows.slice(0,20).map(p=>({productId:p.id,name:p.name,sku:p.sku,barcode:p.barcode,unit:p.unit})),hasMore:rows.length>20};
  }
  assertAgentPermission(current,'moduleInventory');
  if(name==='list_locations'){
   const storeId=scopedStoreId(current,null);
   const rows=(await db.query(`SELECT s.id store_id,s.name store_name,w.id warehouse_id,w.name warehouse_name FROM stores s JOIN warehouses w ON w.organization_id=s.organization_id AND w.store_id=s.id AND w.active=true WHERE s.organization_id=$1 AND s.active=true AND ($2::uuid IS NULL OR s.id=$2) ORDER BY s.name,s.id,w.name,w.id LIMIT 51`,[user.organizationId,storeId])).rows;
   return {kind:'locations',locations:rows.slice(0,50).map(r=>({storeId:r.store_id,storeName:r.store_name,warehouseId:r.warehouse_id,warehouseName:r.warehouse_name})),hasMore:rows.length>50};
  }
  if(name==='get_product_stock'){
   const storeId=scopedStoreId(current,input.storeId);
   if(storeId)await assertOrganizationStore(db,user.organizationId,storeId);
   const product=(await db.query('SELECT id,name,unit FROM products WHERE organization_id=$1 AND id=$2 AND archived=false',[user.organizationId,input.productId])).rows[0];
   if(!product)throw new HttpError(404,'Mahsulot topilmadi','PRODUCT_NOT_FOUND');
   if(input.warehouseId){const w=(await db.query('SELECT store_id FROM warehouses WHERE organization_id=$1 AND id=$2 AND active=true',[user.organizationId,input.warehouseId])).rows[0];if(!w||(storeId&&w.store_id!==storeId))throw new HttpError(404,'Ombor topilmadi','WAREHOUSE_NOT_FOUND')}
   const rows=(await db.query(`SELECT s.id store_id,s.name store_name,w.id warehouse_id,w.name warehouse_name,COALESCE(b.quantity,0)::text quantity FROM stores s JOIN warehouses w ON w.organization_id=s.organization_id AND w.store_id=s.id AND w.active=true LEFT JOIN warehouse_balances b ON b.organization_id=s.organization_id AND b.store_id=s.id AND b.warehouse_id=w.id AND b.product_id=$2 WHERE s.organization_id=$1 AND s.active=true AND ($3::uuid IS NULL OR s.id=$3) AND ($4::uuid IS NULL OR w.id=$4) ORDER BY s.id,w.id LIMIT 51`,[user.organizationId,input.productId,storeId,input.warehouseId||null])).rows;
   return {kind:'stock',productId:product.id,productName:product.name,unit:product.unit,locations:rows.slice(0,50).map(r=>({storeId:r.store_id,storeName:r.store_name,warehouseId:r.warehouse_id,warehouseName:r.warehouse_name,quantity:r.quantity})),hasMore:rows.length>50};
  }
  assertAgentPermission(current,'inventoryAdjust');
  await requireAgentReservation(db,current,requestId,authorizationKey(current));
  const missing=['productId','storeId','warehouseId','quantity','unit','costPrice'].filter(k=>input[k]===null||input[k]===undefined);
  if(missing.length)return clarification('Mahsulot, filial, ombor, miqdor, birlik va kirim tannarxini aniq kiriting.',missing);
  const entities=await loadReceiptEntities(db,current,input),issue=validateAgentReceipt(input,entities.product);
  if(issue)return issue;
  // Existing serial/batch rows are also authoritative when older metadata is incomplete.
  const tracking=(await db.query(`SELECT EXISTS(SELECT 1 FROM product_serials WHERE organization_id=$1 AND product_id=$2) serial,EXISTS(SELECT 1 FROM inventory_batches WHERE organization_id=$1 AND product_id=$2) batch,EXISTS(SELECT 1 FROM inventory_batches WHERE organization_id=$1 AND product_id=$2 AND expiry_date IS NOT NULL) batch_expiry`,[user.organizationId,input.productId])).rows[0];
  if(tracking.serial)return clarification('Bu mahsulot Serial/IMEI bilan kuzatiladi. Odatiy kirim oynasidan foydalaning.',['serials'],{code:'AI_SERIAL_UNSUPPORTED'});
  if(tracking.batch&&!input.batchNo)return clarification('Yangi partiya raqamini kiriting.',['batchNo']);
  if(tracking.batch_expiry&&!input.expiryDate)return clarification('Yangi partiyaning yaroqlilik sanasini kiriting.',['expiryDate']);
  return prepareAgentAction(db,current,{...input,unit:normalizeAgentUnit(entities.product.unit)},{requestId,conversationId,entities});
 });
}
