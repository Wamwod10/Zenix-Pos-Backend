import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";
import { enqueueNotification, enqueueStockLevelNotification } from "../services/notifications.js";
import { hasPermission } from "../lib/permissions.js";
import { assertOrganizationStore, assertStoreScope } from "../lib/storeScope.js";

const router=Router();
router.use(requireAuth,requireOrganization);router.use(requireActiveLicense);
const qty=z.coerce.number().positive();
const uniqueProductArray=(schema,message="Bir mahsulot faqat bitta qatorda bo‘lishi mumkin")=>z.array(schema).min(1).superRefine((items,ctx)=>{
  const seen=new Set();
  items.forEach((item,index)=>{if(seen.has(item.productId))ctx.addIssue({code:z.ZodIssueCode.custom,path:[index,"productId"],message});seen.add(item.productId)});
});

async function lockBalance(client,{orgId,storeId,productId}){
  await client.query(`INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,0,0) ON CONFLICT(store_id,product_id) DO NOTHING`,[orgId,storeId,productId]);
  const row=(await client.query(`SELECT * FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 FOR UPDATE`,[orgId,storeId,productId])).rows[0];
  if(!row)throw new HttpError(404,"Qoldiq yozuvi topilmadi");
  return row;
}
async function assertProduct(client,orgId,productId){
  const row=(await client.query(`SELECT id,name,unit,min_stock FROM products WHERE id=$1 AND organization_id=$2 AND archived=false`,[productId,orgId])).rows[0];
  if(!row)throw new HttpError(404,"Mahsulot topilmadi","PRODUCT_NOT_FOUND");
  return row;
}
async function assertManualQuantityChangeSafe(client,{orgId,storeId,productId,current,after}){
  if(Math.abs(Number(after)-Number(current))<=1e-9)return;
  const [serialState,batchState]=await Promise.all([
    client.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE store_id=$2 AND status='IN_STOCK')::int AS in_stock
      FROM product_serials WHERE organization_id=$1 AND product_id=$3`,[orgId,storeId,productId]),
    client.query(`SELECT count(*)::int AS total,
      COALESCE(sum(remaining_quantity) FILTER (WHERE store_id=$2),0)::numeric AS remaining
      FROM inventory_batches WHERE organization_id=$1 AND product_id=$3`,[orgId,storeId,productId]),
  ]);
  const serialTotal=Number(serialState.rows[0]?.total||0);
  const batchTotal=Number(batchState.rows[0]?.total||0);
  if(serialTotal>0)throw new HttpError(409,"Serial/IMEI kuzatiladigan mahsulot qoldig‘ini umumiy son bilan o‘zgartirib bo‘lmaydi. Serial birliklarini aniq kiriting.","TRACKED_SERIAL_ADJUSTMENT_REQUIRED",{current:Number(current),requested:Number(after),inStockSerials:Number(serialState.rows[0]?.in_stock||0)});
  if(batchTotal>0)throw new HttpError(409,"Partiya bo‘yicha kuzatiladigan mahsulot qoldig‘ini umumiy son bilan o‘zgartirib bo‘lmaydi. Partiya miqdorlarini aniq kiriting.","TRACKED_BATCH_ADJUSTMENT_REQUIRED",{current:Number(current),requested:Number(after),batchRemaining:Number(batchState.rows[0]?.remaining||0)});
}

async function allocateTransferTracking(client,{orgId,transferId,storeId,productId,quantity,balanceQuantity}){
  const sentQty=Number(quantity||0);
  const tracking={serials:[],batches:[],serialTrackedQty:0,batchTrackedQty:0};
  if(sentQty<=0)return tracking;

  const serialRows=(await client.query(`SELECT id,serial FROM product_serials
    WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 AND status='IN_STOCK'
    ORDER BY created_at,id FOR UPDATE`,[orgId,storeId,productId])).rows;
  const fullySerialized=serialRows.length>0&&serialRows.length+1e-9>=Number(balanceQuantity||0);
  if(fullySerialized&&!Number.isInteger(sentQty))throw new HttpError(409,"Serial/IMEI mahsulot transfer miqdori butun son bo‘lishi kerak","SERIAL_QUANTITY_INVALID");
  if(fullySerialized&&serialRows.length<sentQty)throw new HttpError(409,"Transfer uchun Serial/IMEI birliklari yetarli emas","SERIAL_NOT_AVAILABLE");
  const serialTake=Math.min(Math.floor(sentQty),serialRows.length);
  const selectedSerials=serialRows.slice(0,serialTake);
  if(selectedSerials.length){
    await client.query(`UPDATE product_serials SET status='IN_TRANSIT',transfer_id=$4,updated_at=now()
      WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 AND id=ANY($5::uuid[]) AND status='IN_STOCK'`,[orgId,storeId,productId,transferId,selectedSerials.map((row)=>row.id)]);
    tracking.serials=selectedSerials.map((row,index)=>({id:row.id,serial:row.serial,unitOffset:index}));
    tracking.serialTrackedQty=tracking.serials.length;
    tracking.fullySerialized=fullySerialized;
  }

  const batchRows=(await client.query(`SELECT * FROM inventory_batches
    WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 AND remaining_quantity>0
    ORDER BY expiry_date ASC NULLS LAST,created_at ASC,id ASC FOR UPDATE`,[orgId,storeId,productId])).rows;
  let remaining=sentQty,offset=0;
  const batchAvailable=batchRows.reduce((sum,row)=>sum+Number(row.remaining_quantity||0),0);
  tracking.fullyBatched=batchRows.length>0&&batchAvailable+1e-9>=Number(balanceQuantity||0);
  for(const batch of batchRows){
    if(remaining<=1e-9)break;
    const available=Number(batch.remaining_quantity||0),take=Math.min(available,remaining);
    if(take<=0)continue;
    await client.query("UPDATE inventory_batches SET remaining_quantity=remaining_quantity-$2 WHERE id=$1",[batch.id,take]);
    tracking.batches.push({batchId:batch.id,batchNo:batch.batch_no||"",expiryDate:batch.expiry_date||null,unitCost:Number(batch.unit_cost||0),quantity:take,startOffset:offset,endOffset:offset+take});
    offset+=take;remaining-=take;
  }
  tracking.batchTrackedQty=tracking.batches.reduce((sum,row)=>sum+Number(row.quantity||0),0);
  return tracking;
}

async function restoreTransferTrackingToSource(client,{orgId,transferId,storeId,productId,tracking}){
  const serials=Array.isArray(tracking?.serials)?tracking.serials:[];
  if(serials.length){
    const ids=serials.map((entry)=>entry.id).filter(Boolean);
    if(ids.length)await client.query(`UPDATE product_serials SET status='IN_STOCK',transfer_id=NULL,store_id=$2,updated_at=now()
      WHERE organization_id=$1 AND id=ANY($3::uuid[]) AND transfer_id=$4 AND status='IN_TRANSIT'`,[orgId,storeId,ids,transferId]);
  }
  for(const allocation of Array.isArray(tracking?.batches)?tracking.batches:[]){
    if(!allocation.batchId)continue;
    await client.query(`UPDATE inventory_batches
      SET remaining_quantity=LEAST(received_quantity,remaining_quantity+$5)
      WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND product_id=$4`,[allocation.batchId,orgId,storeId,productId,Number(allocation.quantity||0)]);
  }
}

async function receiveTransferTracking(client,{orgId,transferId,fromStoreId,toStoreId,productId,sentQuantity,receivedQuantity,tracking}){
  const sent=Number(sentQuantity||0),received=Number(receivedQuantity||0);
  const receivedTracking={serials:[],missingSerials:[],batches:[],missingBatchQty:0};
  const serials=Array.isArray(tracking?.serials)?tracking.serials:[];
  if(tracking?.fullySerialized){
    if(!Number.isInteger(received))throw new HttpError(409,"Serial/IMEI mahsulot qabul miqdori butun son bo‘lishi kerak","SERIAL_QUANTITY_INVALID");
    if(received>sent)throw new HttpError(409,"Serial/IMEI transferida jo‘natilgandan ortiq qabul qilib bo‘lmaydi","SERIAL_TRANSFER_OVER_RECEIPT");
  }
  if(tracking?.fullyBatched&&received>sent)throw new HttpError(409,"Partiyali mahsulot transferida jo‘natilgandan ortiq qabul qilib bo‘lmaydi","BATCH_TRANSFER_OVER_RECEIPT");
  const receivedSerials=serials.filter((entry)=>Number(entry.unitOffset||0)<received);
  const missingSerials=serials.filter((entry)=>Number(entry.unitOffset||0)>=received);
  if(receivedSerials.length){
    const ids=receivedSerials.map((entry)=>entry.id).filter(Boolean);
    const result=await client.query(`UPDATE product_serials SET status='IN_STOCK',store_id=$2,transfer_id=NULL,updated_at=now()
      WHERE organization_id=$1 AND id=ANY($3::uuid[]) AND transfer_id=$4 AND status='IN_TRANSIT'`,[orgId,toStoreId,ids,transferId]);
    if(result.rowCount!==ids.length)throw new HttpError(409,"Transferdagi Serial/IMEI holati o‘zgargan","SERIAL_TRANSFER_CONFLICT");
    receivedTracking.serials=receivedSerials;
  }
  if(missingSerials.length){
    const ids=missingSerials.map((entry)=>entry.id).filter(Boolean);
    await client.query(`UPDATE product_serials SET status='MISSING',transfer_id=$4,updated_at=now()
      WHERE organization_id=$1 AND store_id=$2 AND id=ANY($3::uuid[]) AND transfer_id=$4 AND status='IN_TRANSIT'`,[orgId,fromStoreId,ids,transferId]);
    receivedTracking.missingSerials=missingSerials;
  }

  const receiveStart=0,receiveEnd=Math.min(received,sent);
  for(const allocation of Array.isArray(tracking?.batches)?tracking.batches:[]){
    const start=Number(allocation.startOffset||0),end=Number(allocation.endOffset??(start+Number(allocation.quantity||0)));
    const overlap=Math.max(0,Math.min(receiveEnd,end)-Math.max(receiveStart,start));
    const allocated=Number(allocation.quantity||Math.max(0,end-start));
    if(overlap>1e-9){
      const row=(await client.query(`INSERT INTO inventory_batches(organization_id,store_id,product_id,reference_id,batch_no,expiry_date,received_quantity,remaining_quantity,unit_cost)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING id`,[orgId,toStoreId,productId,String(transferId),allocation.batchNo||"",allocation.expiryDate||null,overlap,Number(allocation.unitCost||0)])).rows[0];
      receivedTracking.batches.push({...allocation,batchId:row.id,sourceBatchId:allocation.batchId,quantity:overlap,startOffset:Math.max(receiveStart,start),endOffset:Math.min(receiveEnd,end)});
    }
    receivedTracking.missingBatchQty+=Math.max(0,allocated-overlap);
  }
  return receivedTracking;
}
async function dispatchTransfer(client,{orgId,transfer,userId}){
  const sourceStore=await assertOrganizationStore(client,orgId,transfer.from_store_id);
  const destinationStore=await assertOrganizationStore(client,orgId,transfer.to_store_id);
  const items=(await client.query(`SELECT ti.*,p.name,p.unit,p.min_stock FROM stock_transfer_items ti JOIN products p ON p.id=ti.product_id WHERE ti.transfer_id=$1 ORDER BY ti.id`,[transfer.id])).rows;
  for(const line of items){
    const balance=await lockBalance(client,{orgId,storeId:transfer.from_store_id,productId:line.product_id});
    const before=Number(balance.quantity),sentQuantity=Number(line.sent_quantity),after=before-sentQuantity;
    if(after<0)throw new HttpError(409,`${line.name}: jo‘natish uchun qoldiq yetarli emas`,"INSUFFICIENT_STOCK");
    const tracking=await allocateTransferTracking(client,{orgId,transferId:transfer.id,storeId:transfer.from_store_id,productId:line.product_id,quantity:sentQuantity,balanceQuantity:before});
    await client.query(`UPDATE stock_transfer_items SET metadata=metadata||$3::jsonb WHERE transfer_id=$1 AND product_id=$2`,[transfer.id,line.product_id,JSON.stringify({tracking})]);
    await client.query(`UPDATE inventory_balances SET quantity=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3`,[orgId,transfer.from_store_id,line.product_id,after]);
    await enqueueStockLevelNotification(client,{organizationId:orgId,storeId:transfer.from_store_id,eventBase:transfer.id,productId:line.product_id,productName:line.name,storeName:sourceStore.name,before,after,minStock:Number(line.min_stock||0)});
    await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,created_by,metadata) VALUES($1,$2,$3,'transfer_out',$4,$5,$6,'transfer',$7,$8,$9,$10::jsonb)`,[orgId,transfer.from_store_id,line.product_id,-sentQuantity,before,after,transfer.id,"Filiallararo transfer",userId,JSON.stringify({tracking})]);
    line.metadata={...(line.metadata||{}),tracking};
  }
  const updated=(await client.query(`UPDATE stock_transfers SET status='dispatched',dispatched_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[transfer.id])).rows[0];
  await enqueueNotification(client,{organizationId:orgId,storeId:transfer.from_store_id,eventType:"inventory.transfer_dispatched",eventId:transfer.id,payload:{transferId:transfer.id,fromStoreId:transfer.from_store_id,toStoreId:transfer.to_store_id,fromStoreName:sourceStore.name,toStoreName:destinationStore.name,lineCount:items.length,totalQuantity:items.reduce((sum,line)=>sum+Number(line.sent_quantity||0),0)}});
  return {...updated,items};
}

router.post("/receive",requirePermission("inventoryAdjust"),asyncRoute(async(req,res)=>{
  const lineSchema=z.object({
    productId:z.string().uuid().optional().nullable(),name:z.string().trim().max(240).default(""),sku:z.string().trim().max(120).default(""),barcode:z.string().trim().max(120).default(""),
    category:z.string().trim().max(120).default(""),brand:z.string().trim().max(120).default(""),unit:z.string().trim().max(40).default("dona"),quantity:qty,
    costPrice:z.coerce.number().positive(),sellPrice:z.coerce.number().min(0).default(0),wholesalePrice:z.coerce.number().min(0).default(0),minStock:z.coerce.number().min(0).default(0),
    batchNo:z.string().trim().max(120).default(""),expiryDate:z.string().optional().nullable(),serials:z.array(z.string().trim().min(1).max(180)).default([]),metadata:z.record(z.string(),z.any()).default({}),note:z.string().trim().max(500).default(""),
  }).refine((line)=>Boolean(line.productId||line.name),{message:"Mahsulot ID yoki nomi kerak"});
  const input=z.object({
    storeId:z.string().uuid(),lines:z.array(lineSchema).min(1),supplierId:z.string().uuid().optional().nullable(),newSupplier:z.object({name:z.string().trim().min(2).max(180),phone:z.string().trim().max(40).default("")}).optional().nullable(),
    settlement:z.object({status:z.enum(["paid","partial","credit"]).default("paid"),paidAmount:z.coerce.number().min(0).default(0),invoiceNo:z.string().trim().max(120).default(""),dueDate:z.string().optional().nullable(),note:z.string().trim().max(500).default("")}).default({}),
    reference:z.string().trim().max(160).default(""),note:z.string().trim().max(500).default(""),
  }).refine((value)=>!(value.supplierId&&value.newSupplier),{message:"Mavjud yoki yangi ta’minotchidan bittasini tanlang"}).parse(req.body);
  assertStoreScope(req.user,input.storeId);
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId,receiptId=crypto.randomUUID(),updated=[],purchaseLines=[];
    const store=await assertOrganizationStore(client,orgId,input.storeId);
    let supplier=null;
    if(input.supplierId){
      supplier=(await client.query(`SELECT * FROM suppliers WHERE id=$1 AND organization_id=$2 AND archived=false FOR UPDATE`,[input.supplierId,orgId])).rows[0];
      if(!supplier)throw new HttpError(404,"Ta’minotchi topilmadi","SUPPLIER_NOT_FOUND");
    }else if(input.newSupplier){
      supplier=(await client.query(`INSERT INTO suppliers(organization_id,name,phone) VALUES($1,$2,$3) RETURNING *`,[orgId,input.newSupplier.name,input.newSupplier.phone||""])).rows[0];
    }
    for(const line of input.lines){
      let product=null;
      if(line.productId)product=(await client.query(`SELECT * FROM products WHERE id=$1 AND organization_id=$2 AND archived=false FOR UPDATE`,[line.productId,orgId])).rows[0];
      if(line.productId&&!product)throw new HttpError(404,"Mahsulot topilmadi","PRODUCT_NOT_FOUND");
      if(!product){
        if(!line.name)throw new HttpError(400,"Yangi mahsulot nomini kiriting","PRODUCT_NAME_REQUIRED");
        const generatedSku=line.sku||(line.barcode?`BC-${line.barcode}`:`SKU-${crypto.randomUUID().slice(0,8).toUpperCase()}`);
        product=(await client.query(`INSERT INTO products(organization_id,name,sku,barcode,category,brand,unit,cost_price,sell_price,wholesale_price,min_stock,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[orgId,line.name,generatedSku,line.barcode,line.category,line.brand,line.unit,line.costPrice,line.sellPrice,line.wholesalePrice,line.minStock,{...line.metadata,supplierId:supplier?.id||null,supplier:supplier?.name||""}])).rows[0];
      }
      const serials=[...new Set((line.serials||[]).map((value)=>String(value).trim()).filter(Boolean))];
      if(serials.length!==Number(line.serials?.length||0))throw new HttpError(409,`${product.name}: serial/IMEI takrorlangan`,`DUPLICATE_SERIAL`);
      if(serials.length){
        if(!Number.isInteger(Number(line.quantity)))throw new HttpError(409,`${product.name}: serial/IMEI bilan miqdor butun son bo‘lishi kerak`,`SERIAL_QUANTITY_INVALID`);
        if(serials.length!==Number(line.quantity))throw new HttpError(409,`${product.name}: ${line.quantity} dona uchun ${line.quantity} ta serial/IMEI kiriting`,`SERIAL_QUANTITY_MISMATCH`);
        const duplicate=(await client.query(`SELECT serial FROM product_serials WHERE organization_id=$1 AND lower(serial)=ANY($2::text[]) LIMIT 1`,[orgId,serials.map((v)=>v.toLowerCase())])).rows[0];
        if(duplicate)throw new HttpError(409,`Serial/IMEI ${duplicate.serial} allaqachon mavjud`,`SERIAL_EXISTS`);
      }
      const balance=await lockBalance(client,{orgId,storeId:input.storeId,productId:product.id});
      const before=Number(balance.quantity),incomingQty=Number(line.quantity),after=before+incomingQty,oldCost=Number(balance.avg_cost||product.cost_price||0),incomingCost=Number(line.costPrice||0);
      const avg=after>0?((before*oldCost)+(incomingQty*incomingCost))/after:incomingCost;
      await client.query(`UPDATE inventory_balances SET quantity=$4,avg_cost=$5,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3`,[orgId,input.storeId,product.id,after,avg]);
      await client.query(`UPDATE products SET cost_price=$3,sell_price=CASE WHEN $4>0 THEN $4 ELSE sell_price END,metadata=metadata||$5::jsonb,updated_at=now() WHERE id=$1 AND organization_id=$2`,[product.id,orgId,avg,Number(line.sellPrice||0),JSON.stringify({...line.metadata,supplierId:supplier?.id||undefined,supplier:supplier?.name||undefined})]);
      await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,unit_cost,reference_type,reference_id,reason,created_by,metadata)
        VALUES($1,$2,$3,'receive',$4,$5,$6,$7,'receipt',$8,$9,$10,$11::jsonb)`,[orgId,input.storeId,product.id,incomingQty,before,after,incomingCost,receiptId,line.note||input.note||input.reference||"",req.user.id,JSON.stringify({supplierId:supplier?.id||null,reference:input.reference||input.settlement.invoiceNo||"",batchNo:line.batchNo||"",expiryDate:line.expiryDate||null})]);
      if(line.batchNo||line.expiryDate)await client.query(`INSERT INTO inventory_batches(organization_id,store_id,product_id,reference_id,batch_no,expiry_date,received_quantity,remaining_quantity,unit_cost) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)`,[orgId,input.storeId,product.id,receiptId,line.batchNo,line.expiryDate||null,incomingQty,incomingCost]);
      for(const serial of serials)await client.query(`INSERT INTO product_serials(organization_id,store_id,product_id,serial,reference_id) VALUES($1,$2,$3,$4,$5)`,[orgId,input.storeId,product.id,serial,receiptId]);
      const total=incomingQty*incomingCost;
      purchaseLines.push({productId:product.id,product:product.name,quantity:incomingQty,unitCost:incomingCost,total,metadata:line.metadata||{}});
      updated.push({productId:product.id,id:product.id,name:product.name,quantity:after,avgCost:avg,costPrice:avg,before,delta:incomingQty,serials,batchNo:line.batchNo||"",expiryDate:line.expiryDate||null});
    }
    const purchaseTotal=purchaseLines.reduce((sum,line)=>sum+line.total,0);
    let invoice=null;
    if(supplier&&purchaseTotal>0){
      let paid=0;
      if(input.settlement.status==="paid")paid=purchaseTotal;
      else if(input.settlement.status==="partial")paid=Number(input.settlement.paidAmount||0);
      if(paid<0||paid>purchaseTotal)throw new HttpError(409,"To‘langan summa kirim summasiga mos emas","SUPPLIER_PAYMENT_INVALID");
      if(input.settlement.status==="partial"&&(paid<=0||paid>=purchaseTotal))throw new HttpError(409,"Qisman to‘lov 0 dan katta va jami summadan kichik bo‘lishi kerak","SUPPLIER_PARTIAL_INVALID");
      invoice=(await client.query(`INSERT INTO supplier_invoices(organization_id,supplier_id,store_id,invoice_no,total,paid_amount,due_date,note,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[orgId,supplier.id,input.storeId,input.settlement.invoiceNo||input.reference||"",purchaseTotal,paid,purchaseTotal-paid>0?(input.settlement.dueDate||null):null,input.settlement.note||input.note||"",{receiptId}])).rows[0];
      for(const line of purchaseLines)await client.query(`INSERT INTO supplier_invoice_items(invoice_id,product_id,product_name,quantity,unit_cost,total,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`,[invoice.id,line.productId,line.product,line.quantity,line.unitCost,line.total,line.metadata||{}]);
      if(paid>0)await client.query(`INSERT INTO supplier_payments(organization_id,supplier_id,invoice_id,store_id,amount,method,note,metadata,created_by) VALUES($1,$2,$3,$4,$5,'purchase',$6,$7,$8)`,[orgId,supplier.id,invoice.id,input.storeId,paid,"Kirimdagi to‘lov",{receiptId},req.user.id]);
    }
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:input.storeId,action:"receive",entityType:"inventory",entityId:receiptId,title:"Omborga kirim",description:`${input.lines.length} ta mahsulot qatori`});
    await enqueueNotification(client,{organizationId:orgId,storeId:input.storeId,eventType:"inventory.received",eventId:receiptId,payload:{receiptId,lineCount:input.lines.length,total:purchaseTotal,storeId:input.storeId,storeName:store.name,supplierId:supplier?.id||null,supplierName:supplier?.name||""}});
    return {receiptId,updated,purchaseLines,total:purchaseTotal,supplier,invoice,settlement:{paidAmount:invoice?Number(invoice.paid_amount):0,balance:invoice?Math.max(0,Number(invoice.total)-Number(invoice.paid_amount)):0,status:input.settlement.status}};
  });
  ok(res,result,201);
}));

router.post("/adjust",requirePermission("inventoryAdjust"),asyncRoute(async(req,res)=>{
  const input=z.object({storeId:z.string().uuid(),productId:z.string().uuid(),delta:z.coerce.number().refine((v)=>v!==0),reason:z.string().trim().min(2).max(500),allowNegative:z.boolean().default(false)}).parse(req.body);
  assertStoreScope(req.user,input.storeId);
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;const store=await assertOrganizationStore(client,orgId,input.storeId);const product=await assertProduct(client,orgId,input.productId);const balance=await lockBalance(client,{orgId,storeId:input.storeId,productId:input.productId});
    const before=Number(balance.quantity),after=before+Number(input.delta);if(after<0&&!input.allowNegative)throw new HttpError(409,"Qoldiq manfiy bo‘lib qoladi","NEGATIVE_STOCK");
    await assertManualQuantityChangeSafe(client,{orgId,storeId:input.storeId,productId:input.productId,current:before,after});
    const id=crypto.randomUUID();
    await client.query(`UPDATE inventory_balances SET quantity=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3`,[orgId,input.storeId,input.productId,after]);
    await enqueueStockLevelNotification(client,{organizationId:orgId,storeId:input.storeId,eventBase:id,productId:input.productId,productName:product.name,storeName:store.name,before,after,minStock:Number(product.min_stock||0)});
    await client.query(`INSERT INTO stock_movements(id,organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,created_by) VALUES($1,$2,$3,$4,'adjust',$5,$6,$7,'adjustment',$1,$8,$9)`,[id,orgId,input.storeId,input.productId,input.delta,before,after,input.reason,req.user.id]);
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:input.storeId,action:"adjust",entityType:"inventory",entityId:id,title:"Qoldiq tuzatildi",description:`${product.name}: ${before} → ${after}`});
    return {id,productId:input.productId,product:product.name,before,quantity:after,after,delta:Number(input.delta),reason:input.reason,createdAt:new Date().toISOString()};
  });
  ok(res,result);
}));

router.post("/transfers",requirePermission("transferCreate"),asyncRoute(async(req,res)=>{
  const input=z.object({fromStoreId:z.string().uuid(),toStoreId:z.string().uuid(),needsApproval:z.boolean().default(true),items:uniqueProductArray(z.object({productId:z.string().uuid(),quantity:qty}))}).refine((v)=>v.fromStoreId!==v.toStoreId,{message:"Filiallar bir xil bo‘lishi mumkin emas"}).parse(req.body);
  assertStoreScope(req.user,input.fromStoreId);
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;
    await assertOrganizationStore(client,orgId,input.fromStoreId);await assertOrganizationStore(client,orgId,input.toStoreId);
    for(const line of input.items){
      const product=await assertProduct(client,orgId,line.productId);const balance=await lockBalance(client,{orgId,storeId:input.fromStoreId,productId:line.productId});
      const reserved=Number((await client.query(`SELECT COALESCE(sum(ti.sent_quantity),0) reserved FROM stock_transfers t JOIN stock_transfer_items ti ON ti.transfer_id=t.id WHERE t.organization_id=$1 AND t.from_store_id=$2 AND ti.product_id=$3 AND t.status IN('pending','approved')`,[orgId,input.fromStoreId,line.productId])).rows[0].reserved);
      if(Number(balance.quantity)-reserved<Number(line.quantity))throw new HttpError(409,`${product.name}: transfer uchun yetarli bo‘sh qoldiq yo‘q`,"INSUFFICIENT_AVAILABLE_STOCK");
    }
    let transfer=(await client.query(`INSERT INTO stock_transfers(organization_id,from_store_id,to_store_id,status,created_by) VALUES($1,$2,$3,'pending',$4) RETURNING *`,[orgId,input.fromStoreId,input.toStoreId,req.user.id])).rows[0];
    for(const line of input.items)await client.query(`INSERT INTO stock_transfer_items(transfer_id,product_id,sent_quantity) VALUES($1,$2,$3)`,[transfer.id,line.productId,line.quantity]);
    if(!input.needsApproval){
      if(!hasPermission(req.user,"transferApprove"))throw new HttpError(403,"Transferni darhol jo‘natish uchun tasdiqlash ruxsati kerak","FORBIDDEN");
      transfer=await dispatchTransfer(client,{orgId,transfer,userId:req.user.id});
    }
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:input.fromStoreId,action:"create",entityType:"transfer",entityId:transfer.id,title:input.needsApproval?"Transfer tasdiqlashga yuborildi":"Transfer jo‘natildi",description:`${input.items.length} ta mahsulot`});
    return transfer;
  });
  ok(res,{transfer:result},201);
}));

router.post("/transfers/:id/dispatch",requirePermission("transferApprove"),asyncRoute(async(req,res)=>{
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;const transfer=(await client.query(`SELECT * FROM stock_transfers WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.params.id,orgId])).rows[0];
    if(!transfer)throw new HttpError(404,"Transfer topilmadi");assertStoreScope(req.user,transfer.from_store_id);if(!['pending','approved'].includes(transfer.status))throw new HttpError(409,"Transfer jo‘natish holatida emas");
    return dispatchTransfer(client,{orgId,transfer,userId:req.user.id});
  });
  ok(res,{transfer:result});
}));

router.post("/transfers/:id/receive",requirePermission("transferReceive"),asyncRoute(async(req,res)=>{
  const receiveItem=z.object({productId:z.string().uuid(),receivedQuantity:z.coerce.number().min(0)});
  const input=z.object({items:z.array(receiveItem).default([]).superRefine((items,ctx)=>{const seen=new Set();items.forEach((item,index)=>{if(seen.has(item.productId))ctx.addIssue({code:z.ZodIssueCode.custom,path:[index,"productId"],message:"Bir mahsulot qabul ro‘yxatida takrorlanmasin"});seen.add(item.productId)})}),differenceReason:z.string().trim().max(500).default("")}).parse(req.body||{});
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;const transfer=(await client.query(`SELECT * FROM stock_transfers WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.params.id,orgId])).rows[0];
    if(!transfer)throw new HttpError(404,"Transfer topilmadi");assertStoreScope(req.user,transfer.to_store_id);if(transfer.status!=="dispatched")throw new HttpError(409,"Transfer qabul qilish holatida emas");
    const items=(await client.query(`SELECT ti.*,p.name,p.unit FROM stock_transfer_items ti JOIN products p ON p.id=ti.product_id WHERE ti.transfer_id=$1`,[transfer.id])).rows;
    const transferProductIds=new Set(items.map((item)=>String(item.product_id)));
    const unknown=input.items.filter((item)=>!transferProductIds.has(String(item.productId)));
    if(unknown.length)throw new HttpError(400,"Qabul ro‘yxatida transferga tegishli bo‘lmagan mahsulot bor","TRANSFER_ITEM_INVALID",{productIds:unknown.map((item)=>item.productId)});
    const quantityMap=new Map(input.items.map((i)=>[i.productId,Number(i.receivedQuantity)]));
    const results=[];let hasDifference=false;
    for(const line of items){
      const sent=Number(line.sent_quantity),received=quantityMap.has(line.product_id)?quantityMap.get(line.product_id):sent;if(received!==sent)hasDifference=true;
      const tracking=line.metadata?.tracking||{};
      const receivedTracking=await receiveTransferTracking(client,{orgId,transferId:transfer.id,fromStoreId:transfer.from_store_id,toStoreId:transfer.to_store_id,productId:line.product_id,sentQuantity:sent,receivedQuantity:received,tracking});
      const balance=await lockBalance(client,{orgId,storeId:transfer.to_store_id,productId:line.product_id});const before=Number(balance.quantity),after=before+received;
      await client.query(`UPDATE inventory_balances SET quantity=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3`,[orgId,transfer.to_store_id,line.product_id,after]);
      await client.query(`UPDATE stock_transfer_items SET received_quantity=$3,metadata=metadata||$4::jsonb WHERE transfer_id=$1 AND product_id=$2`,[transfer.id,line.product_id,received,JSON.stringify({receiptTracking:receivedTracking})]);
      await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,created_by,metadata) VALUES($1,$2,$3,'transfer_in',$4,$5,$6,'transfer',$7,$8,$9,$10::jsonb)`,[orgId,transfer.to_store_id,line.product_id,received,before,after,transfer.id,received===sent?"":`Farq: ${received-sent}${input.differenceReason?` · ${input.differenceReason}`:""}`,req.user.id,JSON.stringify({sentQuantity:sent,receivedQuantity:received,tracking:receivedTracking})]);
      results.push({productId:line.product_id,product:line.name,unit:line.unit,sentQty:sent,receivedQty:received,difference:received-sent,before,after,tracking:receivedTracking});
    }
    if(hasDifference&&!input.differenceReason)throw new HttpError(400,"Kam yoki ortiq qabul qilingan bo‘lsa, farq sababini yozing","DIFFERENCE_REASON_REQUIRED");
    const status=hasDifference?'received_with_difference':'received';
    const updated=(await client.query(`UPDATE stock_transfers SET status=$2,difference_reason=$3,received_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[transfer.id,status,input.differenceReason])).rows[0];
    const [sourceStore,destinationStore]=await Promise.all([assertOrganizationStore(client,orgId,transfer.from_store_id),assertOrganizationStore(client,orgId,transfer.to_store_id)]);
    await enqueueNotification(client,{organizationId:orgId,storeId:transfer.to_store_id,eventType:"inventory.transfer_received",eventId:transfer.id,payload:{transferId:transfer.id,fromStoreId:transfer.from_store_id,toStoreId:transfer.to_store_id,fromStoreName:sourceStore.name,toStoreName:destinationStore.name,lineCount:results.length,receivedQuantity:results.reduce((sum,line)=>sum+Number(line.receivedQty||0),0),hasDifference,differenceReason:input.differenceReason||""}});
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:transfer.to_store_id,action:"receive",entityType:"transfer",entityId:transfer.id,title:hasDifference?"Transfer farq bilan qabul qilindi":"Transfer qabul qilindi",description:input.differenceReason||""});
    return {...updated,items:results};
  });
  ok(res,{transfer:result});
}));

router.post("/transfers/:id/cancel",requirePermission("transferCancel"),asyncRoute(async(req,res)=>{
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;const transfer=(await client.query(`SELECT * FROM stock_transfers WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.params.id,orgId])).rows[0];
    if(!transfer)throw new HttpError(404,"Transfer topilmadi");
    assertStoreScope(req.user,transfer.from_store_id);
    if(!['pending','approved','dispatched'].includes(transfer.status))throw new HttpError(409,"Bu transferni bekor qilib bo‘lmaydi","TRANSFER_NOT_CANCELLABLE");
    if(transfer.status==='dispatched'){
      const items=(await client.query(`SELECT * FROM stock_transfer_items WHERE transfer_id=$1`,[transfer.id])).rows;
      for(const line of items){
        await restoreTransferTrackingToSource(client,{orgId,transferId:transfer.id,storeId:transfer.from_store_id,productId:line.product_id,tracking:line.metadata?.tracking||{}});
        const balance=await lockBalance(client,{orgId,storeId:transfer.from_store_id,productId:line.product_id});const before=Number(balance.quantity),after=before+Number(line.sent_quantity);
        await client.query(`UPDATE inventory_balances SET quantity=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3`,[orgId,transfer.from_store_id,line.product_id,after]);
        await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,created_by,metadata) VALUES($1,$2,$3,'transfer_cancel',$4,$5,$6,'transfer',$7,'Transfer bekor qilindi',$8,$9::jsonb)`,[orgId,transfer.from_store_id,line.product_id,Number(line.sent_quantity),before,after,transfer.id,req.user.id,JSON.stringify({tracking:line.metadata?.tracking||{}})]);
      }
    }
    const previousStatus=transfer.status;
    const updated=(await client.query(`UPDATE stock_transfers SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *`,[transfer.id])).rows[0];
    const [sourceStore,destinationStore]=await Promise.all([assertOrganizationStore(client,orgId,transfer.from_store_id),assertOrganizationStore(client,orgId,transfer.to_store_id)]);
    await enqueueNotification(client,{organizationId:orgId,storeId:transfer.from_store_id,eventType:"inventory.transfer_cancelled",eventId:transfer.id,payload:{transferId:transfer.id,fromStoreId:transfer.from_store_id,toStoreId:transfer.to_store_id,fromStoreName:sourceStore.name,toStoreName:destinationStore.name,previousStatus}});
    return updated;
  });
  ok(res,{transfer:result});
}));

const countChange=z.object({productId:z.string().uuid(),before:z.coerce.number().min(0),after:z.coerce.number().min(0)});
const countChangesSchema=uniqueProductArray(countChange,"Bir mahsulot inventarizatsiyada faqat bir marta bo‘lishi mumkin");
async function applyCount(client,{orgId,storeId,changes,userId,countId,strictSnapshot}){
  const conflicts=[],movements=[];
  for(const change of changes){
    const product=await assertProduct(client,orgId,change.productId);const balance=await lockBalance(client,{orgId,storeId,productId:change.productId});const current=Number(balance.quantity);
    if(strictSnapshot&&current!==Number(change.before)){conflicts.push({productId:change.productId,product:product.name,snapshot:Number(change.before),current});continue;}
    const after=Number(change.after),delta=after-current;if(delta===0)continue;
    await assertManualQuantityChangeSafe(client,{orgId,storeId,productId:change.productId,current,after});
    await client.query(`UPDATE inventory_balances SET quantity=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3`,[orgId,storeId,change.productId,after]);
    const move=(await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,created_by) VALUES($1,$2,$3,'count',$4,$5,$6,'inventory_count',$7,'Inventarizatsiya',$8) RETURNING *`,[orgId,storeId,change.productId,delta,current,after,countId,userId])).rows[0];
    movements.push({...move,product:product.name});
  }
  return {conflicts,movements};
}

router.post("/counts",requirePermission("inventoryAdjust"),asyncRoute(async(req,res)=>{
  const input=z.object({storeId:z.string().uuid(),requireApproval:z.boolean().default(false),changes:countChangesSchema}).parse(req.body);
  assertStoreScope(req.user,input.storeId);
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;await assertOrganizationStore(client,orgId,input.storeId);const count=(await client.query(`INSERT INTO inventory_counts(organization_id,store_id,status,snapshot,result,created_by) VALUES($1,$2,$3,$4::jsonb,$4::jsonb,$5) RETURNING *`,[orgId,input.storeId,input.requireApproval?'review':'applying',JSON.stringify(input.changes),req.user.id])).rows[0];
    if(input.requireApproval)return {...count,changes:input.changes,status:'review'};
    await client.query("SAVEPOINT inventory_count_apply");
    const applied=await applyCount(client,{orgId,storeId:input.storeId,changes:input.changes,userId:req.user.id,countId:count.id,strictSnapshot:true});
    if(applied.conflicts.length){
      await client.query("ROLLBACK TO SAVEPOINT inventory_count_apply");
      const updated=(await client.query(`UPDATE inventory_counts SET status='conflict',result=$2::jsonb,reviewed_at=now(),reviewed_by=$3 WHERE id=$1 RETURNING *`,[count.id,JSON.stringify({conflicts:applied.conflicts}),req.user.id])).rows[0];
      return {...updated,conflicts:applied.conflicts};
    }
    await client.query("RELEASE SAVEPOINT inventory_count_apply");
    const updated=(await client.query(`UPDATE inventory_counts SET status='approved',reviewed_at=now(),reviewed_by=$2 WHERE id=$1 RETURNING *`,[count.id,req.user.id])).rows[0];
    return {...updated,changes:input.changes,movements:applied.movements};
  });
  if(result.conflicts?.length)throw new HttpError(409,"Qoldiq inventarizatsiya vaqtida o‘zgargan","INVENTORY_COUNT_CONFLICT",{countId:result.id,conflicts:result.conflicts});
  ok(res,{count:result},201);
}));

router.post("/counts/:id/review",requirePermission("inventoryCountApprove"),asyncRoute(async(req,res)=>{
  const input=z.object({decision:z.enum(['approve','reject'])}).parse(req.body);
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;const count=(await client.query(`SELECT * FROM inventory_counts WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.params.id,orgId])).rows[0];
    if(!count)throw new HttpError(404,"Inventarizatsiya topilmadi");assertStoreScope(req.user,count.store_id);if(!['review','conflict'].includes(count.status))throw new HttpError(409,"Inventarizatsiya allaqachon ko‘rib chiqilgan");
    if(input.decision==='reject')return (await client.query(`UPDATE inventory_counts SET status='rejected',reviewed_at=now(),reviewed_by=$2 WHERE id=$1 RETURNING *`,[count.id,req.user.id])).rows[0];
    const changes=Array.isArray(count.snapshot)?count.snapshot:[];
    await client.query("SAVEPOINT inventory_count_review");
    const applied=await applyCount(client,{orgId,storeId:count.store_id,changes,userId:req.user.id,countId:count.id,strictSnapshot:true});
    if(applied.conflicts.length){
      await client.query("ROLLBACK TO SAVEPOINT inventory_count_review");
      const updated=(await client.query(`UPDATE inventory_counts SET status='conflict',result=$2::jsonb,reviewed_at=now(),reviewed_by=$3 WHERE id=$1 RETURNING *`,[count.id,JSON.stringify({conflicts:applied.conflicts}),req.user.id])).rows[0];
      return {...updated,conflicts:applied.conflicts};
    }
    await client.query("RELEASE SAVEPOINT inventory_count_review");
    const updated=(await client.query(`UPDATE inventory_counts SET status='approved',result=$2::jsonb,reviewed_at=now(),reviewed_by=$3 WHERE id=$1 RETURNING *`,[count.id,JSON.stringify(changes),req.user.id])).rows[0];return {...updated,movements:applied.movements};
  });
  if(result.conflicts?.length)throw new HttpError(409,`${result.conflicts.length} ta mahsulot qoldig‘i o‘zgargan. Qayta sanang.`,`INVENTORY_COUNT_CONFLICT`,{countId:result.id,conflicts:result.conflicts});
  ok(res,{count:result});
}));

export default router;
