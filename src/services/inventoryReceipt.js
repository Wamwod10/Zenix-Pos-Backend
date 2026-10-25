import crypto from 'node:crypto';
import {assertFileAssetBinding} from './fileAssets.js';
import {z} from 'zod';
import {requestFingerprint} from './posReplay.js';
import {lineAmount,sumMoney} from '../lib/posMoney.js';
import {setInventoryWarehouse} from './warehouses.js';
import {validateProductMetadata} from '../lib/productOptions.js';
import {HttpError} from '../lib/http.js';
import {assertOrganizationStore,assertStoreScope} from '../lib/storeScope.js';
import {writeAudit} from './audit.js';
import {enqueueNotification} from './notifications.js';
const qty=z.coerce.number().positive().max(999999999).refine(value=>Math.abs(value*1000-Math.round(value*1000))<0.000001,'Miqdor 3 kasr xonadan oshmasin');
async function lockBalance(client,{orgId,storeId,productId}){
  await client.query(`INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,0,0) ON CONFLICT(store_id,product_id) DO NOTHING`,[orgId,storeId,productId]);
  const row=(await client.query(`SELECT * FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 FOR UPDATE`,[orgId,storeId,productId])).rows[0];
  if(!row)throw new HttpError(404,"Qoldiq yozuvi topilmadi");
  return row;
}
  const lineSchema=z.object({
    productId:z.string().uuid().optional().nullable(),name:z.string().trim().max(240).default(""),sku:z.string().trim().max(120).default(""),barcode:z.string().trim().max(120).default(""),
    category:z.string().trim().max(120).default(""),brand:z.string().trim().max(120).default(""),unit:z.string().trim().max(40).default("dona"),quantity:qty,
    costPrice:z.coerce.number().positive(),sellPrice:z.coerce.number().min(0).default(0),wholesalePrice:z.coerce.number().min(0).default(0),minStock:z.coerce.number().min(0).default(0),
    batchNo:z.string().trim().max(120).default(""),expiryDate:z.string().date().optional().nullable(),manufacturedDate:z.string().date().optional().nullable(),serials:z.array(z.string().trim().min(1).max(180)).default([]),metadata:z.record(z.string(),z.any()).default({}).transform(validateProductMetadata),note:z.string().trim().max(500).default(""),
  }).refine((line)=>Boolean(line.productId||line.name||line.barcode),{message:"Mahsulot ID yoki nomi kerak"});
  const inventoryReceiptSchema=z.object({
    storeId:z.string().uuid(),warehouseId:z.string().uuid().optional().nullable(),lines:z.array(lineSchema).min(1).max(250),supplierId:z.string().uuid().optional().nullable(),newSupplier:z.object({name:z.string().trim().min(2).max(180),phone:z.string().trim().max(40).default("")}).optional().nullable(),
    settlement:z.object({status:z.enum(["paid","partial","credit"]).default("paid"),paidAmount:z.coerce.number().min(0).default(0),invoiceNo:z.string().trim().max(120).default(""),dueDate:z.string().optional().nullable(),note:z.string().trim().max(500).default("")}).default({}),
    clientReference:z.string().trim().max(160).default(""),reference:z.string().trim().max(160).default(""),note:z.string().trim().max(500).default(""),
  }).refine((value)=>!(value.supplierId&&value.newSupplier),{message:"Mavjud yoki yangi ta’minotchidan bittasini tanlang"});

export {inventoryReceiptSchema};
// The caller owns the transaction; ledger, audit and notifications remain atomic.
export async function receiveInventory(client,user,input){
  assertStoreScope(user,input.storeId);
    const orgId=user.organizationId,receiptId=crypto.randomUUID(),updated=[],purchaseLines=[];
    const store=await assertOrganizationStore(client,orgId,input.storeId);
    await setInventoryWarehouse(client,{organizationId:orgId,storeId:input.storeId,warehouseId:input.warehouseId});
    const fingerprint=requestFingerprint({userId:user.id,...input});
    if(input.clientReference){
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`inventory-receipt:${orgId}:${input.clientReference}`]);
      const previous=(await client.query("SELECT metadata FROM audit_logs WHERE organization_id=$1 AND action='receive' AND entity_type='inventory' AND metadata->>'clientReference'=$2",[orgId,input.clientReference])).rows[0];
      if(previous){if(previous.metadata.fingerprint!==fingerprint)throw new HttpError(409,'Kirim identifikatori boshqa malumot bilan ishlatilgan','IDEMPOTENCY_CONFLICT');return previous.metadata.response;}
    }
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
      if(!product&&line.barcode){
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`product-barcode:${orgId}:${line.barcode}`]);
        product=(await client.query('SELECT * FROM products WHERE organization_id=$1 AND barcode=$2 FOR UPDATE',[orgId,line.barcode])).rows[0];
        if(product?.archived)throw new HttpError(409,'Mahsulot arxivlangan. Avval tiklang','PRODUCT_ARCHIVED');
      }
      if(Object.prototype.hasOwnProperty.call(line.metadata||{},'imageKey'))await assertFileAssetBinding(client,{user,id:line.metadata.imageKey,purpose:'product',existingId:product?.metadata?.imageKey});
      if(!product){
        if(!line.name)throw new HttpError(400,"Yangi mahsulot nomini kiriting","PRODUCT_NAME_REQUIRED");
        const generatedSku=line.sku||(line.barcode?`BC-${line.barcode}`:`SKU-${crypto.randomUUID().slice(0,8).toUpperCase()}`);
        product=(await client.query(`INSERT INTO products(organization_id,name,sku,barcode,category,brand,unit,cost_price,sell_price,wholesale_price,min_stock,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[orgId,line.name,generatedSku,line.barcode,line.category,line.brand,line.unit,line.costPrice,line.sellPrice,line.wholesalePrice,line.minStock,{...line.metadata,supplierId:supplier?.id||null,supplier:supplier?.name||""}])).rows[0];
      }
      const serials=[...new Set((line.serials||[]).map((value)=>String(value).trim()).filter(Boolean))];
      const options=validateProductMetadata({...product.metadata,...line.metadata,manufacturedDate:line.manufacturedDate||line.metadata.manufacturedDate,expiryDate:line.expiryDate||line.metadata.expiryDate});
      if(['serial','imei'].includes(options.trackingMode)&&!serials.length)throw new HttpError(400,'Har bir dona uchun IMEI/seriya kiriting','SERIAL_QUANTITY_MISMATCH');
      const lotNo=line.batchNo||(options.lotTracking?`LOT-${receiptId}`:'');
      if(serials.length!==Number(line.serials?.length||0))throw new HttpError(409,`${product.name}: serial/IMEI takrorlangan`,`DUPLICATE_SERIAL`);
      if(serials.length){
        if(!Number.isInteger(Number(line.quantity)))throw new HttpError(409,`${product.name}: serial/IMEI bilan miqdor butun son bo‘lishi kerak`,`SERIAL_QUANTITY_INVALID`);
        if(serials.length!==Number(line.quantity))throw new HttpError(409,`${product.name}: ${line.quantity} dona uchun ${line.quantity} ta serial/IMEI kiriting`,`SERIAL_QUANTITY_MISMATCH`);
        const duplicate=(await client.query(`SELECT serial FROM product_serials WHERE organization_id=$1 AND lower(serial)=ANY($2::text[]) LIMIT 1`,[orgId,serials.map((v)=>v.toLowerCase())])).rows[0];
        if(duplicate)throw new HttpError(409,`Serial/IMEI ${duplicate.serial} allaqachon mavjud`,`SERIAL_EXISTS`);
      }
      const balance=await lockBalance(client,{orgId,storeId:input.storeId,productId:product.id});
      const before=Number(balance.quantity),incomingQty=Number(line.quantity),after=before+incomingQty,oldCost=Number(balance.avg_cost??product.cost_price??0),incomingCost=Number(line.costPrice||0);
      const avg=after>0?((before*oldCost)+(incomingQty*incomingCost))/after:incomingCost;
      await client.query(`UPDATE inventory_balances SET quantity=$4,avg_cost=$5,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3`,[orgId,input.storeId,product.id,after,avg]);
      await client.query(`UPDATE products SET cost_price=$3,sell_price=CASE WHEN $4>0 THEN $4 ELSE sell_price END,metadata=metadata||$5::jsonb,updated_at=now() WHERE id=$1 AND organization_id=$2`,[product.id,orgId,avg,Number(line.sellPrice||0),JSON.stringify({...line.metadata,supplierId:supplier?.id||undefined,supplier:supplier?.name||undefined})]);
      await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,unit_cost,reference_type,reference_id,reason,created_by,metadata)
        VALUES($1,$2,$3,'receive',$4,$5,$6,$7,'receipt',$8,$9,$10,$11::jsonb)`,[orgId,input.storeId,product.id,incomingQty,before,after,incomingCost,receiptId,line.note||input.note||input.reference||"",user.id,JSON.stringify({supplierId:supplier?.id||null,reference:input.reference||input.settlement.invoiceNo||"",batchNo:lotNo,expiryDate:line.expiryDate||null,manufacturedDate:line.manufacturedDate||null,warehouseId:input.warehouseId||null})]);
      if(lotNo||line.expiryDate||line.manufacturedDate)await client.query(`INSERT INTO inventory_batches(organization_id,store_id,product_id,reference_id,batch_no,expiry_date,received_quantity,remaining_quantity,unit_cost,manufactured_date) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)`,[orgId,input.storeId,product.id,receiptId,lotNo,line.expiryDate||null,incomingQty,incomingCost,line.manufacturedDate||null]);
      for(const serial of serials)await client.query(`INSERT INTO product_serials(organization_id,store_id,product_id,serial,reference_id) VALUES($1,$2,$3,$4,$5)`,[orgId,input.storeId,product.id,serial,receiptId]);
      const total=lineAmount(incomingQty,incomingCost);
      purchaseLines.push({productId:product.id,product:product.name,quantity:incomingQty,unitCost:incomingCost,total,metadata:line.metadata||{}});
      updated.push({productId:product.id,id:product.id,name:product.name,unit:product.unit,quantity:after,avgCost:avg,costPrice:avg,before,delta:incomingQty,serials,batchNo:lotNo,expiryDate:line.expiryDate||null,manufacturedDate:line.manufacturedDate||null,warehouseId:input.warehouseId||null});
    }
    const purchaseTotal=sumMoney(purchaseLines.map(line=>line.total));
    let invoice=null;
    if(supplier&&purchaseTotal>0){
      let paid=0;
      if(input.settlement.status==="paid")paid=purchaseTotal;
      else if(input.settlement.status==="partial")paid=Number(input.settlement.paidAmount||0);
      if(paid<0||paid>purchaseTotal)throw new HttpError(409,"To‘langan summa kirim summasiga mos emas","SUPPLIER_PAYMENT_INVALID");
      if(input.settlement.status==="partial"&&(paid<=0||paid>=purchaseTotal))throw new HttpError(409,"Qisman to‘lov 0 dan katta va jami summadan kichik bo‘lishi kerak","SUPPLIER_PARTIAL_INVALID");
      invoice=(await client.query(`INSERT INTO supplier_invoices(organization_id,supplier_id,store_id,invoice_no,total,paid_amount,due_date,note,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[orgId,supplier.id,input.storeId,input.settlement.invoiceNo||input.reference||"",purchaseTotal,paid,purchaseTotal-paid>0?(input.settlement.dueDate||null):null,input.settlement.note||input.note||"",{receiptId}])).rows[0];
      for(const line of purchaseLines)await client.query(`INSERT INTO supplier_invoice_items(invoice_id,product_id,product_name,quantity,unit_cost,total,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)`,[invoice.id,line.productId,line.product,line.quantity,line.unitCost,line.total,line.metadata||{}]);
      if(paid>0)await client.query(`INSERT INTO supplier_payments(organization_id,supplier_id,invoice_id,store_id,amount,method,note,metadata,created_by) VALUES($1,$2,$3,$4,$5,'purchase',$6,$7,$8)`,[orgId,supplier.id,invoice.id,input.storeId,paid,"Kirimdagi to‘lov",{receiptId},user.id]);
    }
    const response={receiptId,updated,purchaseLines,total:purchaseTotal,supplier,invoice,settlement:{paidAmount:invoice?Number(invoice.paid_amount):0,balance:invoice?Math.max(0,Number(invoice.total)-Number(invoice.paid_amount)):0,status:input.settlement.status}};
    await writeAudit(client,{organizationId:orgId,userId:user.id,storeId:input.storeId,action:"receive",entityType:"inventory",entityId:receiptId,title:"Omborga kirim",description:`${input.lines.length} ta mahsulot qatori`,metadata:{clientReference:input.clientReference,fingerprint,response}});
    await enqueueNotification(client,{organizationId:orgId,storeId:input.storeId,eventType:"inventory.received",eventId:receiptId,payload:{receiptId,lineCount:input.lines.length,total:purchaseTotal,storeId:input.storeId,storeName:store.name,supplierId:supplier?.id||null,supplierName:supplier?.name||""}});
    return response;
}
