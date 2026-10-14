import {z} from 'zod';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {withTransaction} from '../db/tx.js';
import {HttpError} from '../lib/http.js';
import {requestFingerprint} from './posReplay.js';
import {assertStoreScope,assertOrganizationStore} from '../lib/storeScope.js';
import {authorizationKey} from './aiPolicy.js';
import {assertAgentEnabled,assertAgentPermission,recheckAgentActor,requireAgentReservation} from './aiAgentActor.js';
import {inventoryReceiptSchema,receiveInventory} from './inventoryReceipt.js';
import {organizationCalendarDateISO} from '../lib/businessDate.js';
import {lineAmount} from '../lib/posMoney.js';
import {writeAudit} from './audit.js';
import {bumpWorkspaceRevision} from '../lib/workspaceRevision.js';

export const productSnapshot=p=>({id:p.id,name:p.name,sku:p.sku,barcode:p.barcode,unit:p.unit,costPrice:String(p.cost_price),sellPrice:String(p.sell_price),metadata:p.metadata||{},updatedAt:new Date(p.updated_at).toISOString()});
export const warehouseSnapshot=(w,s)=>({id:w.id,storeId:w.store_id,name:w.name,updatedAt:new Date(w.updated_at).toISOString(),storeName:s.name});
export async function loadReceiptEntities(db,user,{productId,storeId,warehouseId}){
 assertStoreScope(user,storeId);
 const store=await assertOrganizationStore(db,user.organizationId,storeId);
 const product=(await db.query('SELECT * FROM products WHERE organization_id=$1 AND id=$2 AND archived=false FOR UPDATE',[user.organizationId,productId])).rows[0];
 if(!product)throw new HttpError(404,'Mahsulot topilmadi','PRODUCT_NOT_FOUND');
 const warehouse=(await db.query('SELECT * FROM warehouses WHERE organization_id=$1 AND store_id=$2 AND id=$3 AND active=true FOR SHARE',[user.organizationId,storeId,warehouseId])).rows[0];
 if(!warehouse)throw new HttpError(404,'Ombor topilmadi','WAREHOUSE_NOT_FOUND');
 return {product,warehouse,store};
}
export function publicAgentAction(row,{token=false}={}){
 return {kind:'action',action:{id:row.id,type:row.type,status:row.status,expiresAt:new Date(row.expires_at).toISOString(),preview:row.preview,...(token&&row.status==='PENDING'?{confirmationToken:row.confirmation_token}:{}),...(row.result?{result:row.result}:{})}};
}
async function auditAgentAction(db,row,action,title){
 const p=row.preview;
 await writeAudit(db,{organizationId:row.organization_id,userId:row.user_id,storeId:p.storeId,action,entityType:'ai_agent_action',entityId:row.id,title,
  after:{status:row.status},metadata:{requestId:row.request_id,actionType:row.type,status:row.status,productId:p.productId,productName:p.productName,storeId:p.storeId,warehouseId:p.warehouseId,quantity:p.quantity,unit:p.unit,costPrice:p.costPrice,batchNo:p.batchNo||null,expiryDate:p.expiryDate||null}});
}
async function transitionAgentAction(db,row,status,action,title){
 const updated=(await db.query('UPDATE ai_agent_actions SET status=$2,completed_at=now() WHERE id=$1 RETURNING *',[row.id,status])).rows[0];
 await auditAgentAction(db,updated,action,title);return updated;
}
export async function prepareAgentAction(db,user,input,{requestId,conversationId,entities}){
 const key=authorizationKey(user);await requireAgentReservation(db,user,requestId,key);
 z.string().uuid().parse(conversationId);
 if(input.expiryDate&&input.expiryDate<organizationCalendarDateISO())return {kind:'clarification',message:'Yaroqlilik muddati tugagan. Sanani tekshiring yoki odatiy kirim oynasidan foydalaning.',fields:['expiryDate'],code:'AI_EXPIRED_STOCK_UNSUPPORTED'};
 const id=randomUUID();
 const payload=inventoryReceiptSchema.parse({storeId:input.storeId,warehouseId:input.warehouseId,lines:[{productId:input.productId,quantity:input.quantity,unit:entities.product.unit,costPrice:input.costPrice,batchNo:input.batchNo||'',expiryDate:input.expiryDate}],clientReference:`ai-action:${id}`,note:'ZENIX AI tasdiqlangan kirim',settlement:{status:'credit'}});
 const fingerprint=requestFingerprint(payload);
 const previous=(await db.query('SELECT * FROM ai_agent_actions WHERE organization_id=$1 AND user_id=$2 AND request_id=$3',[user.organizationId,user.id,requestId])).rows[0];
 if(previous){
  const old={...previous.payload,clientReference:payload.clientReference};
  if(requestFingerprint(old)!==fingerprint)throw new HttpError(409,'Bu so‘rov uchun boshqa amal tayyorlangan','AI_ACTION_CONFLICT');
  if(previous.session_id!==user.sessionId||previous.conversation_id!==conversationId)throw new HttpError(403,'Amal sessiyasi mos emas','AI_ACCESS_CHANGED');
  return publicAgentAction(previous,{token:true});
 }
 const preview={...input,productName:entities.product.name,storeName:entities.store.name,warehouseName:entities.warehouse.name,total:lineAmount(input.quantity,input.costPrice)};
 const row=(await db.query(`INSERT INTO ai_agent_actions(id,organization_id,user_id,session_id,request_id,conversation_id,authorization_key,type,payload,fingerprint,product_snapshot,warehouse_snapshot,preview,confirmation_token)
 VALUES($1,$2,$3,$4,$5,$6,$7,'stock_receipt',$8,$9,$10,$11,$12,$13) RETURNING *`,[id,user.organizationId,user.id,user.sessionId,requestId,conversationId,key,payload,fingerprint,productSnapshot(entities.product),warehouseSnapshot(entities.warehouse,entities.store),preview,randomBytes(32).toString('base64url')])).rows[0];
 await auditAgentAction(db,row,'prepare','AI kirim tayyorlandi');
 return publicAgentAction(row,{token:true});
}
const confirmationSchema=z.object({confirmationToken:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
function sameToken(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}
async function lockedAction(db,user,id,token){
 z.string().uuid().parse(id);
 const row=(await db.query('SELECT * FROM ai_agent_actions WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND session_id=$4 FOR UPDATE',[id,user.organizationId,user.id,user.sessionId])).rows[0];
 if(!row)throw new HttpError(404,'Amal topilmadi','AI_ACTION_NOT_FOUND');
 if(token!==undefined&&!sameToken(token,row.confirmation_token))throw new HttpError(403,'Tasdiqlash kaliti noto‘g‘ri','AI_CONFIRMATION_INVALID');
 if(row.authorization_key!==authorizationKey(user))throw new HttpError(403,'Amal ruxsatlari o‘zgargan','AI_ACCESS_CHANGED');
 return row;
}
async function expireAction(db,row){
 if(row.status==='PENDING'&&new Date(row.expires_at)<=new Date())return transitionAgentAction(db,row,'EXPIRED','expire','AI kirim tasdiqlash muddati tugadi');
 return row;
}
export async function confirmAgentAction(user,id,body,{settings}={}){
 assertAgentEnabled(settings,{write:true});const {confirmationToken}=confirmationSchema.parse(body);
 return withTransaction(async db=>{
  const current=await recheckAgentActor(db,user);assertAgentPermission(current,'moduleInventory','inventoryAdjust');
  let row=await expireAction(db,await lockedAction(db,current,id,confirmationToken));
  if(row.status!=='PENDING')return publicAgentAction(row);
  await requireAgentReservation(db,current,row.request_id,row.authorization_key,{completed:true,actionId:row.id});
  const payload=inventoryReceiptSchema.parse(row.payload);
  if(requestFingerprint(payload)!==row.fingerprint)throw new HttpError(409,'Amal ma’lumotlari mos emas','AI_ACTION_CONFLICT');
  let entities;
  try{entities=await loadReceiptEntities(db,current,{...payload,productId:payload.lines[0].productId})}
  catch(error){if(!['PRODUCT_NOT_FOUND','WAREHOUSE_NOT_FOUND','STORE_NOT_FOUND'].includes(error.code))throw error;return publicAgentAction(await transitionAgentAction(db,row,'STALE','stale','AI kirim malumotlari eskirgan'))}
  const {product,warehouse,store}=entities;
  if(requestFingerprint(productSnapshot(product))!==requestFingerprint(row.product_snapshot)||requestFingerprint(warehouseSnapshot(warehouse,store))!==requestFingerprint(row.warehouse_snapshot)){
   row=await transitionAgentAction(db,row,'STALE','stale','AI kirim malumotlari eskirgan');return publicAgentAction(row);
  }
  const tracking=(await db.query('SELECT EXISTS(SELECT 1 FROM product_serials WHERE organization_id=$1 AND product_id=$2) serial',[user.organizationId,product.id])).rows[0];
  if(tracking.serial||(payload.lines[0].expiryDate&&payload.lines[0].expiryDate<organizationCalendarDateISO()))return publicAgentAction(await transitionAgentAction(db,row,'STALE','stale','AI kirim malumotlari eskirgan'));
  const warehouseBefore=String((await db.query('SELECT quantity FROM warehouse_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 AND warehouse_id=$4 FOR UPDATE',[user.organizationId,payload.storeId,product.id,payload.warehouseId])).rows[0]?.quantity||0);
  const result=await receiveInventory(db,current,payload),line=result.updated[0];
  // VERIFY the authoritative balance, warehouse partition and immutable movement before commit.
  const verified=(await db.query(`SELECT b.quantity,w.quantity warehouse_quantity,(w.quantity-$7::numeric=$6::numeric) warehouse_delta_matches,
   (SELECT count(*)::int FROM stock_movements m WHERE m.organization_id=$1 AND m.store_id=$2 AND m.product_id=$3 AND m.reference_type='receipt' AND m.reference_id=$5 AND m.type='receive' AND m.quantity=$6) movements,
   (SELECT COALESCE(sum(wb.quantity),0) FROM warehouse_balances wb WHERE wb.organization_id=$1 AND wb.store_id=$2 AND wb.product_id=$3) warehouse_total
   FROM inventory_balances b JOIN warehouse_balances w ON w.organization_id=b.organization_id AND w.store_id=b.store_id AND w.product_id=b.product_id AND w.warehouse_id=$4
   WHERE b.organization_id=$1 AND b.store_id=$2 AND b.product_id=$3`,[user.organizationId,payload.storeId,line.productId,payload.warehouseId,result.receiptId,payload.lines[0].quantity,warehouseBefore])).rows[0];
  if(!verified||Number(verified.quantity)!==Number(line.quantity.toFixed(3))||Number(verified.warehouse_total)!==Number(line.quantity.toFixed(3))||verified.movements!==1||verified.warehouse_delta_matches!==true)throw new HttpError(409,'Kirim tekshiruvi bajarilmadi','AI_RECEIPT_VERIFY_FAILED');
  const safeResult={receiptId:result.receiptId,productId:line.productId,before:line.before,after:Number(verified.quantity),delta:line.delta,unit:line.unit,warehouseId:payload.warehouseId};
  await writeAudit(db,{organizationId:user.organizationId,userId:user.id,storeId:payload.storeId,action:'confirm',entityType:'ai_agent_action',entityId:row.id,title:'AI kirimi tasdiqlandi',metadata:{requestId:row.request_id,receiptId:result.receiptId,fingerprint:row.fingerprint}});
  // AI chat/preview routes are excluded from revision middleware. A real
  // confirmed receipt must still invalidate other POS clients, exactly once.
  await bumpWorkspaceRevision(db,user.organizationId);
  row=(await db.query("UPDATE ai_agent_actions SET status='CONFIRMED',result=$2,completed_at=now() WHERE id=$1 RETURNING *",[row.id,safeResult])).rows[0];return publicAgentAction(row);
 });
}
export async function cancelAgentAction(user,id,body,{settings}={}){
 assertAgentEnabled(settings);const {confirmationToken}=confirmationSchema.parse(body);
 return withTransaction(async db=>{const current=await recheckAgentActor(db,user);assertAgentPermission(current,'moduleInventory','inventoryAdjust');let row=await expireAction(db,await lockedAction(db,current,id,confirmationToken));if(row.status==='PENDING')row=await transitionAgentAction(db,row,'CANCELLED','cancel','AI kirim bekor qilindi');return publicAgentAction(row)});
}
export async function getAgentActionStatus(user,id,{settings}={}){
 assertAgentEnabled(settings);
 return withTransaction(async db=>{const current=await recheckAgentActor(db,user);assertAgentPermission(current,'moduleInventory','inventoryAdjust');return publicAgentAction(await expireAction(db,await lockedAction(db,current,id)),{token:true})});
}
