import { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { pool } from "../db/pool.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { enqueueNotification, enqueueStockLevelNotification } from "../services/notifications.js";
import { writeAudit } from "../services/audit.js";
import { assertOrganizationStore, assertStoreScope } from "../lib/storeScope.js";
import { lockStoreTradingAuthorization } from "../services/storeTradingHolds.js";
import { organizationBusinessDateISO } from "../lib/businessDate.js";
import { assertShiftCashAvailable } from "../lib/shiftCash.js";
import { assertSharedOpenShift } from "../lib/branchShift.js";
import { planSaleTracking, consumeSaleTracking } from "../services/saleTrackingSelections.js";
import {lineAmount,refundAmount,sumMoney,roundMoney} from '../lib/posMoney.js';
import {holdSchema,holdView,holdIntent,validateHoldCatalog} from '../services/saleHolds.js';
import {requestFingerprint,assertSaleReplay,assertRefundReplay} from '../services/posReplay.js';
import {salesPage} from '../services/salesDirectory.js';

const router=Router();
router.use(requireAuth,requireOrganization);router.use(requireActiveLicense);

const DEFAULT_POS_RULES=Object.freeze({
  discountLimit:20,
  cashierDiscountAllowed:false,
  paymentMethods:{cash:true,card:true,transfer:true,split:true},
});

const effectivePosRules=(organizationSettings={},storeId)=>{
  const workspace=organizationSettings?.workspaceSettings||{};
  const base=workspace.pos||{};
  const override=workspace.storeOverrides?.[storeId]?.pos||{};
  return {
    ...DEFAULT_POS_RULES,
    ...base,
    ...override,
    paymentMethods:{...DEFAULT_POS_RULES.paymentMethods,...(base.paymentMethods||{}),...(override.paymentMethods||{})},
  };
};

const normalizedLinePricing=({product,line,posRules,user})=>{
  const quantity=Number(line.quantity||0);
  const requestedBase=Number(line.unitPrice||0);
  const requestedDiscount=Number(line.discountPercent||0);
  const requestedFinal=requestedBase*(1-requestedDiscount/100);
  const catalogPrice=Number(product.sell_price||0);
  const authorityBase=catalogPrice>0?catalogPrice:requestedBase;
  const finalUnitPrice=requestedFinal;
  const effectiveDiscount=authorityBase>0&&finalUnitPrice<authorityBase
    ? Math.max(0,Math.min(100,(1-finalUnitPrice/authorityBase)*100))
    : 0;
  const discountLimit=Math.max(0,Math.min(100,Number(posRules.discountLimit??DEFAULT_POS_RULES.discountLimit)));
  if(user.appRole==="CASHIER"&&posRules.cashierDiscountAllowed!==true&&effectiveDiscount>0.0001){
    throw new HttpError(403,`${product.name}: kassir uchun chegirma o‘chirilgan`,`DISCOUNT_FORBIDDEN`);
  }
  if(effectiveDiscount-discountLimit>0.0001){
    throw new HttpError(409,`${product.name}: chegirma ${discountLimit}% limitdan oshib ketdi`,`DISCOUNT_LIMIT_EXCEEDED`,{productId:product.id,discountPercent:effectiveDiscount,discountLimit});
  }
  const storedUnitPrice=finalUnitPrice>authorityBase?finalUnitPrice:authorityBase;
  const storedDiscount=storedUnitPrice>0&&finalUnitPrice<storedUnitPrice
    ? Math.max(0,Math.min(100,(1-finalUnitPrice/storedUnitPrice)*100))
    : 0;
  const gross=lineAmount(quantity,storedUnitPrice);
  const lineTotal=lineAmount(quantity,finalUnitPrice);
  return {unitPrice:storedUnitPrice,discountPercent:storedDiscount,gross,lineTotal,effectiveDiscount,finalUnitPrice};
};

const moneyValue=z.coerce.number().min(0).max(9000000000000).refine(value=>Math.abs(value*100-Math.round(value*100))<0.00001,'Summa 2 kasr belgidan oshmasin');
const paymentSchema=z.object({method:z.enum(["cash","card","transfer"]),amount:moneyValue,metadata:z.record(z.string(),z.any()).default({})});
const saleItemSchema=z.object({
  productId:z.string().uuid(),quantity:z.coerce.number().positive().max(999999999).refine(value=>Math.abs(value*1000-Math.round(value*1000))<0.00001,"Miqdor 3 kasr belgidan oshmasin"),unitPrice:z.coerce.number().min(0),
  discountPercent:z.coerce.number().min(0).max(100).default(0),metadata:z.record(z.string(),z.any()).default({}),
});
const saleSchema=z.object({
  storeId:z.string().uuid(),shiftId:z.string().uuid(),clientReference:z.string().trim().max(120).default(""),
  businessDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  items:z.array(saleItemSchema).min(1).superRefine((items,ctx)=>{
    const seen=new Set();
    items.forEach((item,index)=>{
      if(seen.has(item.productId))ctx.addIssue({code:z.ZodIssueCode.custom,path:[index,"productId"],message:"Bir mahsulot savdoda faqat bitta qatorda bo‘lishi mumkin"});
      seen.add(item.productId);
    });
  }),
  payments:z.array(paymentSchema).default([]),customer:z.record(z.string(),z.any()).default({}),customerId:z.string().uuid().optional().nullable(),creditAmount:moneyValue.default(0),creditDueDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),metadata:z.record(z.string(),z.any()).default({}),
});

async function restoreInventoryBatches(client,{organizationId,storeId,productId,tracking,returnStart,returnEnd}){
  const allocations=Array.isArray(tracking?.batches)?tracking.batches:[];
  const restored=[];
  for(const allocation of allocations){
    const start=Number(allocation.startOffset||0),end=Number(allocation.endOffset??(start+Number(allocation.quantity||0)));
    const overlap=Math.max(0,Math.min(returnEnd,end)-Math.max(returnStart,start));
    if(overlap<=1e-9||!allocation.batchId)continue;
    const row=(await client.query(`UPDATE inventory_batches
      SET remaining_quantity=LEAST(received_quantity,remaining_quantity+$5)
      WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND product_id=$4
      RETURNING id,batch_no,remaining_quantity`,[allocation.batchId,organizationId,storeId,productId,overlap])).rows[0];
    if(row)restored.push({batchId:row.id,batchNo:row.batch_no||"",quantity:overlap,remaining:Number(row.remaining_quantity||0)});
  }
  return restored;
}

async function nextSaleIdentity(client,orgId){
  // Serialize number allocation per organization so concurrent terminals cannot
  // generate the same receipt number inside separate transactions. The same
  // locked organization row is also the authoritative timezone/business-day source.
  const organization=(await client.query("SELECT id,timezone,settings FROM organizations WHERE id=$1 FOR UPDATE",[orgId])).rows[0];
  if(!organization)throw new HttpError(404,"Tashkilot topilmadi","ORGANIZATION_NOT_FOUND");
  const {rows}=await client.query("SELECT count(*)::bigint+1 n FROM sales WHERE organization_id=$1",[orgId]);
  return {saleNumber:`S-${String(rows[0].n).padStart(6,"0")}`,businessDate:organizationBusinessDateISO(organization)};
}

async function lockBusinessDay(client,{organizationId,storeId,businessDate,allowClosed=false}){
  const lockKey=`${organizationId}:${storeId}:${businessDate}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[lockKey]);
  const closed=(await client.query("SELECT id FROM business_days WHERE organization_id=$1 AND store_id=$2 AND business_date=$3 LIMIT 1",[organizationId,storeId,businessDate])).rows[0];
  if(closed&&!allowClosed)throw new HttpError(409,"Bu biznes kuni allaqachon yopilgan","BUSINESS_DAY_CLOSED",{businessDate});
  return closed||null;
}

router.get('/page',requirePermission('moduleSales'),asyncRoute(async(req,res)=>{
  const query=z.object({storeId:z.string().uuid(),limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(req.query);
  assertStoreScope(req.user,query.storeId);
  const organization=(await pool.query('SELECT timezone,settings FROM organizations WHERE id=$1',[req.user.organizationId])).rows[0];
  const page=await salesPage(pool,{...query,organizationId:req.user.organizationId,businessDate:organizationBusinessDateISO(organization),timeZone:organization?.timezone});
  ok(res,page);
}));

router.get("/holds",requirePermission("moduleSales"),asyncRoute(async(req,res)=>{
  const storeId=z.string().uuid('Filial ID noto‘g‘ri').parse(req.query.storeId);
  if(!storeId)throw new HttpError(400,"Filial topilmadi");
  assertStoreScope(req.user,storeId);
  const {rows}=await pool.query("SELECT * FROM sale_holds WHERE organization_id=$1 AND store_id=$2 AND user_id=$3 ORDER BY created_at DESC",[req.user.organizationId,storeId,req.user.id]);
  ok(res,{holds:rows.map(holdView)});
}));

router.post("/holds",requirePermission("moduleSales"),asyncRoute(async(req,res)=>{
  const input=holdSchema.parse(req.body);assertStoreScope(req.user,input.storeId);
  const hold=await withTransaction(async(client)=>{
    await lockStoreTradingAuthorization(client,{organizationId:req.user.organizationId,storeId:input.storeId});
    await assertOrganizationStore(client,req.user.organizationId,input.storeId);
    if(input.clientReference){
      const existing=(await client.query('SELECT * FROM sale_holds WHERE organization_id=$1 AND client_reference=$2',[req.user.organizationId,input.clientReference])).rows[0];
      if(existing){if(existing.store_id!==input.storeId||existing.user_id!==req.user.id||requestFingerprint(holdIntent(holdView(existing)))!==requestFingerprint(holdIntent(input)))throw new HttpError(409,'Savat identifikatori boshqa savat uchun ishlatilgan','IDEMPOTENCY_CONFLICT');return existing;}
    }
    const validated=await validateHoldCatalog(client,req.user.organizationId,input);
    if(input.shiftId){const shift=(await client.query("SELECT 1 FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open'",[input.shiftId,req.user.organizationId,input.storeId])).rows[0];if(!shift)throw new HttpError(409,"Smena ochiq emas","SHIFT_REQUIRED");}
    const row=(await client.query(`INSERT INTO sale_holds(organization_id,store_id,user_id,shift_id,name,cart,customer,note,cart_discount_percent,total,customer_id,client_reference)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[req.user.organizationId,input.storeId,req.user.id,input.shiftId||null,input.name,JSON.stringify(validated.cart),input.customer,input.note,input.cartDiscountPct,validated.total,input.customerId||null,input.clientReference])).rows[0];
    return row;
  });
  ok(res,{hold:holdView(hold)},201);
}));

router.delete("/holds/:id",requirePermission("moduleSales"),asyncRoute(async(req,res)=>{
  const row=await withTransaction(async(client)=>{
    await lockStoreTradingAuthorization(client,{organizationId:req.user.organizationId});
    const existing=(await client.query("SELECT store_id FROM sale_holds WHERE id=$1 AND organization_id=$2 AND user_id=$3",[req.params.id,req.user.organizationId,req.user.id])).rows[0];
    if(!existing)throw new HttpError(404,"Ushlab turilgan savat topilmadi");
    assertStoreScope(req.user,existing.store_id);
    await lockStoreTradingAuthorization(client,{organizationId:req.user.organizationId,storeId:existing.store_id});
    const deleted=(await client.query("DELETE FROM sale_holds WHERE id=$1 AND organization_id=$2 AND user_id=$3 RETURNING *",[req.params.id,req.user.organizationId,req.user.id])).rows[0];
    if(!deleted)throw new HttpError(404,"Ushlab turilgan savat topilmadi");
    return deleted;
  });
  ok(res,{deleted:true,hold:holdView(row)});
}));

router.post("/business-days/close",requirePermission("closeBusinessDay"),asyncRoute(async(req,res)=>{
  const input=z.object({storeId:z.string().uuid(),businessDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),metadata:z.record(z.string(),z.any()).default({})}).parse(req.body);
  assertStoreScope(req.user,input.storeId);
  const day=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;
    await lockStoreTradingAuthorization(client,{organizationId:orgId,storeId:input.storeId});
    const store=await assertOrganizationStore(client,orgId,input.storeId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${orgId}:${input.storeId}:${input.businessDate}`]);
    const existing=(await client.query("SELECT * FROM business_days WHERE organization_id=$1 AND store_id=$2 AND business_date=$3 FOR UPDATE",[orgId,input.storeId,input.businessDate])).rows[0];
    if(existing)return existing;
    const openShift=await client.query("SELECT 1 FROM shifts WHERE organization_id=$1 AND store_id=$2 AND status='open' LIMIT 1",[orgId,input.storeId]);
    if(openShift.rowCount)throw new HttpError(409,"Biznes kunini yopishdan oldin ochiq smenalarni yoping","OPEN_SHIFT_EXISTS");
    const totals=(await client.query(`
      WITH day_sales AS (
        SELECT id,total FROM sales
        WHERE organization_id=$1 AND store_id=$2 AND business_date=$3
      ), payment_totals AS (
        SELECT sp.method,COALESCE(sum(sp.amount),0) amount
        FROM sale_payments sp JOIN day_sales ds ON ds.id=sp.sale_id
        GROUP BY sp.method
      ), day_returns AS (
        SELECT amount,metadata FROM sale_returns
        WHERE organization_id=$1 AND store_id=$2 AND business_date=$3
      ), refund_totals AS (
        SELECT
          COALESCE(sum(amount),0) total,
          COALESCE(sum(COALESCE((metadata->'refundBreakdown'->>'cash')::numeric,0)),0) cash,
          COALESCE(sum(COALESCE((metadata->'refundBreakdown'->>'card')::numeric,0)),0) card,
          COALESCE(sum(COALESCE((metadata->'refundBreakdown'->>'transfer')::numeric,0)),0) transfer
        FROM day_returns
      )
      SELECT (SELECT count(*)::int FROM day_sales) sale_count,
             COALESCE((SELECT sum(total) FROM day_sales),0)-(SELECT total FROM refund_totals) total,
             COALESCE((SELECT amount FROM payment_totals WHERE method='cash'),0)-(SELECT cash FROM refund_totals) cash,
             COALESCE((SELECT amount FROM payment_totals WHERE method='card'),0)-(SELECT card FROM refund_totals) card,
             COALESCE((SELECT amount FROM payment_totals WHERE method='transfer'),0)-(SELECT transfer FROM refund_totals) transfer`,[orgId,input.storeId,input.businessDate])).rows[0];
    const row=(await client.query(`INSERT INTO business_days(organization_id,store_id,business_date,total,cash,card,transfer,sale_count,metadata,closed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[orgId,input.storeId,input.businessDate,Number(totals.total||0),Number(totals.cash||0),Number(totals.card||0),Number(totals.transfer||0),Number(totals.sale_count||0),input.metadata,req.user.id])).rows[0];
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:input.storeId,action:"close",entityType:"business_day",entityId:row.id,title:"Kunlik savdo yakunlandi",description:`${row.sale_count} ta tranzaksiya`});
    await enqueueNotification(client,{organizationId:orgId,storeId:input.storeId,eventType:"daily.report",eventId:row.id,payload:{businessDate:input.businessDate,storeName:store.name,saleCount:Number(row.sale_count||0),total:Number(row.total||0),cash:Number(row.cash||0),card:Number(row.card||0),transfer:Number(row.transfer||0)}});
    return row;
  });
  ok(res,{day});
}));

router.post("/",requirePermission("moduleSales"),asyncRoute(async(req,res)=>{
  const input=saleSchema.parse(req.body);assertStoreScope(req.user,input.storeId);
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;const store=await assertOrganizationStore(client,orgId,input.storeId);
    const organization=await lockStoreTradingAuthorization(client,{organizationId:orgId,storeId:input.storeId});
    const posRules=effectivePosRules(organization.settings||{},input.storeId);
    const paymentMethods=input.payments.map((payment)=>payment.method);
    if(new Set(paymentMethods).size!==paymentMethods.length)throw new HttpError(400,"Bir xil to‘lov usulini bir savdoda takrorlamang","DUPLICATE_PAYMENT_METHOD");
    if(input.payments.length>1&&posRules.paymentMethods?.split===false)throw new HttpError(409,"Bo‘lib to‘lash ushbu filialda o‘chirilgan","SPLIT_PAYMENT_DISABLED");
    for(const payment of input.payments){
      if(posRules.paymentMethods?.[payment.method]===false)throw new HttpError(409,`${payment.method} to‘lov usuli ushbu filialda o‘chirilgan`,`PAYMENT_METHOD_DISABLED`,{method:payment.method});
    }
    if(input.clientReference){
      const duplicate=(await client.query("SELECT * FROM sales WHERE organization_id=$1 AND client_reference=$2 LIMIT 1",[orgId,input.clientReference])).rows[0];
      if(duplicate){assertSaleReplay(duplicate,{storeId:input.storeId,actorId:req.user.id,fingerprint:requestFingerprint(input)});return duplicate;}
    }
    if(input.shiftId){
      // Hold the same row lock as shift closing until sale commit.
      const shift=(await client.query("SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open' FOR UPDATE",[input.shiftId,orgId,input.storeId])).rows[0];
      assertSharedOpenShift(shift,{organizationId:orgId,storeId:input.storeId,actorId:req.user.id});
    }
    const normalized=[];let subtotal=0,total=0;
    for(const line of [...input.items].sort((a,b)=>a.productId.localeCompare(b.productId))){
      const product=(await client.query("SELECT * FROM products WHERE id=$1 AND organization_id=$2 AND archived=false",[line.productId,orgId])).rows[0];
      if(!product)throw new HttpError(404,"Mahsulot topilmadi");
      await client.query(`INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,0,0) ON CONFLICT(store_id,product_id) DO NOTHING`,[orgId,input.storeId,line.productId]);
      const balance=(await client.query("SELECT * FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 FOR UPDATE",[orgId,input.storeId,line.productId])).rows[0];
      const quantity=Number(line.quantity),before=Number(balance.quantity),after=before-quantity;
      if(after<0)throw new HttpError(409,`${product.name} uchun qoldiq yetarli emas`,`INSUFFICIENT_STOCK`);
      const tracking=await planSaleTracking(client,{organizationId:orgId,storeId:input.storeId,productId:line.productId,quantity,stock:before,metadata:line.metadata});
      const pricing=normalizedLinePricing({product,line,posRules,user:req.user});
      subtotal=sumMoney([subtotal,pricing.gross]);total=sumMoney([total,pricing.lineTotal]);
      normalized.push({product,balance,before,after,quantity,unitPrice:pricing.unitPrice,discountPercent:pricing.discountPercent,lineTotal:pricing.lineTotal,metadata:line.metadata||{},tracking,effectiveDiscount:pricing.effectiveDiscount,finalUnitPrice:pricing.finalUnitPrice});
    }
    const paymentTotal=sumMoney(input.payments.map(p=>p.amount));
    const creditAmount=Number(input.creditAmount||0);
    if(sumMoney([paymentTotal,creditAmount,-total])!==0)throw new HttpError(409,"To‘lov va nasiya summasi savdo jami bilan mos emas","PAYMENT_MISMATCH");
    let creditCustomer=null;
    if(creditAmount>0){
      if(!input.customerId)throw new HttpError(409,"Nasiya savdo uchun mijozni tanlang","CREDIT_CUSTOMER_REQUIRED");
      if(!input.creditDueDate)throw new HttpError(409,"Nasiya to‘lov muddatini kiriting","CREDIT_DUE_DATE_REQUIRED");
      creditCustomer=(await client.query("SELECT * FROM customers WHERE id=$1 AND organization_id=$2 AND archived=false FOR UPDATE",[input.customerId,orgId])).rows[0];
      if(!creditCustomer)throw new HttpError(404,"Mijoz topilmadi");
      const currentDebt=Number((await client.query("SELECT COALESCE(sum(amount),0) balance FROM customer_ledger WHERE organization_id=$1 AND customer_id=$2",[orgId,input.customerId])).rows[0]?.balance||0);
      const limit=Number(creditCustomer.credit_limit||0);
      if(limit>0&&currentDebt+creditAmount>limit+0.001)throw new HttpError(409,"Mijoz kredit limiti yetarli emas","CREDIT_LIMIT_EXCEEDED",{currentDebt,creditAmount,creditLimit:limit});
    }
    const {saleNumber,businessDate}=await nextSaleIdentity(client,orgId);
    await lockBusinessDay(client,{organizationId:orgId,storeId:input.storeId,businessDate});
    const saleMetadata={...input.metadata,requestFingerprint:requestFingerprint(input),clientBusinessDate:input.businessDate||null};
    const sale=(await client.query(`INSERT INTO sales(organization_id,store_id,shift_id,seller_id,sale_number,client_reference,subtotal,discount_amount,total,customer,business_date,metadata,customer_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[orgId,input.storeId,input.shiftId,req.user.id,saleNumber,input.clientReference,subtotal,subtotal-total,total,input.customer,businessDate,saleMetadata,input.customerId||null])).rows[0];
    for(const line of normalized){
      await consumeSaleTracking(client,{organizationId:orgId,storeId:input.storeId,productId:line.product.id,saleId:sale.id,tracking:line.tracking});
      const authoritativeTracking=line.tracking;
      const itemMetadata={...line.metadata,unit:line.product.unit,unitCost:Number(line.balance.avg_cost||line.product.cost_price||0),tracking:authoritativeTracking};
      await client.query(`INSERT INTO sale_items(sale_id,product_id,product_name,sku,barcode,quantity,unit_price,discount_percent,line_total,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[sale.id,line.product.id,line.product.name,line.product.sku,line.product.barcode,line.quantity,line.unitPrice,line.discountPercent,line.lineTotal,itemMetadata]);
      await client.query("UPDATE inventory_balances SET quantity=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3",[orgId,input.storeId,line.product.id,line.after]);
      await enqueueStockLevelNotification(client,{organizationId:orgId,storeId:input.storeId,eventBase:sale.id,productId:line.product.id,productName:line.product.name,storeName:store.name,before:line.before,after:line.after,minStock:Number(line.product.min_stock||0)});
      await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,unit_cost,reference_type,reference_id,created_by,metadata) VALUES($1,$2,$3,'sale',$4,$5,$6,$7,'sale',$8,$9,$10::jsonb)`,[orgId,input.storeId,line.product.id,-line.quantity,line.before,line.after,Number(line.balance.avg_cost||line.product.cost_price||0),sale.id,req.user.id,JSON.stringify({tracking:authoritativeTracking})]);
    }
    for(const payment of input.payments)await client.query("INSERT INTO sale_payments(sale_id,method,amount,metadata) VALUES($1,$2,$3,$4)",[sale.id,payment.method,payment.amount,payment.metadata||{}]);
    if(creditAmount>0)await client.query(`INSERT INTO customer_ledger(organization_id,customer_id,store_id,sale_id,entry_type,amount,due_date,reference,note,created_by) VALUES($1,$2,$3,$4,'CREDIT_SALE',$5,$6,$7,$8,$9)`,[orgId,input.customerId,input.storeId,sale.id,creditAmount,input.creditDueDate,saleNumber,String(input.metadata?.note||""),req.user.id]);
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:input.storeId,action:"create",entityType:"sale",entityId:sale.id,title:"Savdo amalga oshirildi",description:`${saleNumber} · ${total}`});
    await enqueueNotification(client,{organizationId:orgId,storeId:input.storeId,eventType:"sale.completed",eventId:sale.id,payload:{saleId:sale.id,saleNumber,total,storeId:input.storeId,storeName:store.name,sellerId:req.user.id,sellerName:req.user.name,itemCount:normalized.reduce((sum,line)=>sum+Number(line.quantity||0),0),paymentMethods:input.payments.map((payment)=>payment.method)}});
    const savedItems=(await client.query(`SELECT product_id,product_name,sku,barcode,quantity,unit_price,discount_percent,line_total,metadata FROM sale_items WHERE sale_id=$1 ORDER BY id`,[sale.id])).rows;
    return {...sale,items:savedItems.map((item)=>({productId:item.product_id,name:item.product_name,sku:item.sku,barcode:item.barcode,quantity:Number(item.quantity),unitPrice:Number(item.unit_price),finalPrice:Number(item.unit_price)*(1-Number(item.discount_percent)/100),discountPercent:Number(item.discount_percent),lineTotal:Number(item.line_total),metadata:item.metadata||{},tracking:item.metadata?.tracking||null})),payments:input.payments};
  });
  ok(res,{sale:result},201);
}));

router.post("/:id/returns",requirePermission("returns"),asyncRoute(async(req,res)=>{
  const input=z.object({
    productId:z.string().uuid(),quantity:z.coerce.number().positive().max(999999999).refine(value=>Math.abs(value*1000-Math.round(value*1000))<0.00001,"Miqdor 3 kasr belgidan oshmasin"),reason:z.string().trim().min(2).max(500),refundMethod:z.enum(["original","cash","card","transfer"]).default("original"),
    refundShiftId:z.string().uuid().optional().nullable(),refundBreakdown:z.object({cash:moneyValue.default(0),card:moneyValue.default(0),transfer:moneyValue.default(0)}).optional(),clientReference:z.string().trim().max(120).default(""),metadata:z.record(z.string(),z.any()).default({}),
  }).parse(req.body);
  const result=await withTransaction(async(client)=>{
    const orgId=req.user.organizationId;
    // Organization precedes sale/shift row locks on every protected write.
    await lockStoreTradingAuthorization(client,{organizationId:orgId});
    if(input.clientReference){
      const duplicate=(await client.query("SELECT * FROM sale_returns WHERE organization_id=$1 AND client_reference=$2 LIMIT 1",[orgId,input.clientReference])).rows[0];
      if(duplicate){assertStoreScope(req.user,duplicate.store_id);assertRefundReplay(duplicate,{...input,saleId:req.params.id,actorId:req.user.id});return duplicate;}
    }
    const sale=(await client.query("SELECT * FROM sales WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,orgId])).rows[0];
    if(!sale)throw new HttpError(404,"Savdo topilmadi");assertStoreScope(req.user,sale.store_id);await assertOrganizationStore(client,orgId,sale.store_id);
    const organization=await lockStoreTradingAuthorization(client,{organizationId:orgId,storeId:sale.store_id});
    const returnBusinessDate=organizationBusinessDateISO(organization);
    await lockBusinessDay(client,{organizationId:orgId,storeId:sale.store_id,businessDate:returnBusinessDate});
    const item=(await client.query("SELECT si.*,COALESCE((SELECT sm.unit_cost FROM stock_movements sm WHERE sm.reference_type='sale' AND sm.reference_id=si.sale_id::text AND sm.product_id=si.product_id ORDER BY sm.created_at LIMIT 1),0) unit_cost FROM sale_items si WHERE si.sale_id=$1 AND si.product_id=$2",[sale.id,input.productId])).rows[0];if(!item)throw new HttpError(404,"Savdoda bu mahsulot topilmadi");
    const priorReturns=(await client.query("SELECT COALESCE(sum(quantity),0) qty,COALESCE(sum(amount),0) amount FROM sale_returns WHERE sale_id=$1 AND product_id=$2",[sale.id,input.productId])).rows[0];
    const returned=Number(priorReturns.qty);
    let amount;
    try{amount=refundAmount(item.line_total,item.quantity,priorReturns.qty,input.quantity,priorReturns.amount)}catch{throw new HttpError(409,'Qaytarish miqdori yoki summasi sotilgan qiymatdan oshdi','RETURN_QUANTITY_EXCEEDED')}
    // Lock the customer consistently with payment posting. A refund must not race
    // the same customer's debt repayment while computing remaining credit.
    if(sale.customer_id){
      const locked=(await client.query("SELECT id FROM customers WHERE id=$1 AND organization_id=$2 FOR UPDATE",[sale.customer_id,orgId])).rows[0];
      if(!locked)throw new HttpError(409,"Mijoz topilmadi","CUSTOMER_NOT_FOUND");
    }
    let breakdown=null;
    let creditReduction=0;
    let creditLedgerId=null;
    if(input.refundMethod==="original"){
      if(sale.customer_id){
        const credit=(await client.query(`SELECT cl.id,GREATEST(cl.amount-COALESCE(sum(a.amount),0),0) open_amount
          FROM customer_ledger cl LEFT JOIN customer_payment_allocations a ON a.credit_ledger_id=cl.id
          WHERE cl.organization_id=$1 AND cl.customer_id=$2 AND cl.sale_id=$3 AND cl.entry_type='CREDIT_SALE'
          GROUP BY cl.id ORDER BY cl.id LIMIT 1`,[orgId,sale.customer_id,sale.id])).rows[0];
        creditReduction=Math.min(amount,Math.max(0,Number(credit?.open_amount||0)));
        creditLedgerId=credit?.id||null;
      }
      // Include settled credit repayments attributed to this sale; original
      // payment rows alone exclude later debt payments, causing false 409s.
      const captured=(await client.query(`
        SELECT method,sum(amount)::numeric amount FROM (
          SELECT method,amount FROM sale_payments WHERE sale_id=$1
          UNION ALL
          SELECT pay.payment_method method,a.amount
          FROM customer_payment_allocations a
          JOIN customer_ledger credit ON credit.id=a.credit_ledger_id
          JOIN customer_ledger pay ON pay.id=a.payment_ledger_id
          WHERE credit.organization_id=$2 AND credit.sale_id=$1
            AND credit.entry_type='CREDIT_SALE' AND pay.entry_type='PAYMENT'
        ) payments WHERE method IN ('cash','card','transfer') GROUP BY method`,[sale.id,orgId])).rows;
      const refunded=(await client.query(`SELECT metadata->'refundBreakdown' AS breakdown
        FROM sale_returns WHERE sale_id=$1 AND organization_id=$2`,[sale.id,orgId])).rows;
      const available={cash:0,card:0,transfer:0};
      for(const row of captured)available[row.method]=sumMoney([available[row.method],row.amount||0]);
      for(const row of refunded)for(const method of Object.keys(available))available[method]=sumMoney([available[method],-Number(row.breakdown?.[method]||0)]);
      for(const method of Object.keys(available))available[method]=Math.max(0,available[method]);
      const payable=Math.max(0,sumMoney([amount,-creditReduction]));
      breakdown={cash:0,card:0,transfer:0};
      if(input.refundBreakdown){
        breakdown={...input.refundBreakdown};
        for(const method of Object.keys(available)){
          if(roundMoney(breakdown[method]||0)>available[method])
            throw new HttpError(409,"Qaytarish avval to‘langan summadan katta","REFUND_EXCEEDS_CAPTURED_PAYMENT");
        }
      }else{
        let remaining=payable;
        const totalAvailable=sumMoney(Object.values(available));
        if(totalAvailable<payable)throw new HttpError(409,"Qaytarish uchun tasdiqlangan to‘lov yetarli emas","REFUND_EXCEEDS_CAPTURED_PAYMENT");
        for(const method of Object.keys(available)){
          const allocated=Math.min(remaining,available[method]);
          breakdown[method]=roundMoney(allocated);remaining=sumMoney([remaining,-allocated]);
        }
      }
    }else{
      // Explicit cash/card/transfer cannot pay out an unpaid credit balance.
      const captured=(await client.query(`SELECT COALESCE(sum(amount),0) total FROM (
        SELECT amount FROM sale_payments WHERE sale_id=$1
        UNION ALL SELECT a.amount FROM customer_payment_allocations a
        JOIN customer_ledger credit ON credit.id=a.credit_ledger_id
        JOIN customer_ledger pay ON pay.id=a.payment_ledger_id
        WHERE credit.sale_id=$1 AND credit.organization_id=$2 AND pay.entry_type='PAYMENT'
      ) x`,[sale.id,orgId])).rows[0];
      const prior=(await client.query(`SELECT COALESCE(sum(
        COALESCE((metadata->'refundBreakdown'->>'cash')::numeric,0)+
        COALESCE((metadata->'refundBreakdown'->>'card')::numeric,0)+
        COALESCE((metadata->'refundBreakdown'->>'transfer')::numeric,0)),0) total
        FROM sale_returns WHERE sale_id=$1 AND organization_id=$2`,[sale.id,orgId])).rows[0];
      if(sumMoney([captured?.total||0,-Number(prior?.total||0)])<amount)
        throw new HttpError(409,"Qaytarish uchun to‘langan summa yetarli emas","REFUND_EXCEEDS_CAPTURED_PAYMENT");
      breakdown={cash:input.refundMethod==="cash"?amount:0,card:input.refundMethod==="card"?amount:0,transfer:input.refundMethod==="transfer"?amount:0};
    }
    const breakdownTotal=sumMoney(Object.values(breakdown));
    if(sumMoney([breakdownTotal,creditReduction,-amount])!==0)throw new HttpError(409,"Qaytarish to‘lov taqsimoti summaga mos emas","REFUND_MISMATCH");
    if(Number(breakdown.cash||0)>0){
      if(!input.refundShiftId)throw new HttpError(409,"Naqd qaytarish uchun ochiq smena kerak","SHIFT_REQUIRED");
      const shift=(await client.query("SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open' FOR UPDATE",[input.refundShiftId,orgId,sale.store_id])).rows[0];
      assertSharedOpenShift(shift,{organizationId:orgId,storeId:sale.store_id,actorId:req.user.id});
      await assertShiftCashAvailable(client,shift,Number(breakdown.cash||0),{message:"Qaytarish uchun kassada yetarli naqd pul yo‘q"});
    }
    await client.query(`INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,0,0) ON CONFLICT(store_id,product_id) DO NOTHING`,[orgId,sale.store_id,input.productId]);
    const balance=(await client.query("SELECT * FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 FOR UPDATE",[orgId,sale.store_id,input.productId])).rows[0];
    const before=Number(balance.quantity),after=before+Number(input.quantity);
    const ret=(await client.query(`INSERT INTO sale_returns(organization_id,sale_id,store_id,product_id,quantity,amount,reason,refund_method,business_date,metadata,created_by,client_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[orgId,sale.id,sale.store_id,input.productId,input.quantity,amount,input.reason,input.refundMethod,returnBusinessDate,{...input.metadata,refundBreakdown:breakdown,unitCost:Number(item.unit_cost||0),creditReduction,refundShiftId:input.refundShiftId||null},req.user.id,input.clientReference||null])).rows[0];
    if(creditReduction>0&&sale.customer_id&&creditLedgerId){const refundLedger=(await client.query(`INSERT INTO customer_ledger(organization_id,customer_id,store_id,sale_id,entry_type,amount,reference,note,created_by,metadata) VALUES($1,$2,$3,$4,'REFUND',$5,$6,$7,$8,$9) RETURNING id`,[orgId,sale.customer_id,sale.store_id,sale.id,-creditReduction,sale.sale_number,`Qaytarish: ${input.reason}`,req.user.id,{returnId:ret.id}])).rows[0];await client.query(`INSERT INTO customer_payment_allocations(organization_id,customer_id,payment_ledger_id,credit_ledger_id,amount) VALUES($1,$2,$3,$4,$5)`,[orgId,sale.customer_id,refundLedger.id,creditLedgerId,creditReduction]);}
    await client.query("UPDATE inventory_balances SET quantity=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND store_id=$2 AND product_id=$3",[orgId,sale.store_id,input.productId,after]);
    await client.query("UPDATE sales SET returned_amount=returned_amount+$2 WHERE id=$1",[sale.id,amount]);
    await client.query(`INSERT INTO stock_movements(organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,reference_type,reference_id,reason,created_by) VALUES($1,$2,$3,'return',$4,$5,$6,'return',$7,$8,$9)`,[orgId,sale.store_id,input.productId,input.quantity,before,after,ret.id,input.reason,req.user.id]);
    if(Number(breakdown.cash||0)>0)await client.query(`INSERT INTO shift_movements(organization_id,shift_id,type,amount,reason,source,reference_id,created_by) VALUES($1,$2,'out',$3,$4,'return',$5,$6)`,[orgId,input.refundShiftId,Number(breakdown.cash),`Qaytarish: ${sale.sale_number}`,ret.id,req.user.id]);
    const tracking=item.metadata?.tracking||{};
    const trackedSerialEntries=(tracking.serials||tracking.serializedUnits||[]).map((entry,index)=>({serial:String(entry?.serial||entry||"").trim(),unitOffset:Number(entry?.unitOffset??index)})).filter((entry)=>entry.serial);
    let serialEntries=trackedSerialEntries;
    if(!serialEntries.length){
      const legacy=(await client.query(`SELECT serial FROM product_serials WHERE organization_id=$1 AND product_id=$2 AND sale_id=$3 AND status='SOLD' ORDER BY created_at,id`,[orgId,input.productId,sale.id])).rows;
      serialEntries=legacy.map((entry,index)=>({serial:String(entry.serial||""),unitOffset:index}));
    }
    if(serialEntries.length&&!Number.isInteger(Number(input.quantity)))throw new HttpError(409,"Serial/IMEI mahsulot qaytarish miqdori butun son bo‘lishi kerak","SERIAL_QUANTITY_INVALID");
    const returnStart=returned,returnEnd=returned+Number(input.quantity);
    const returnedSerials=serialEntries.filter((entry)=>entry.unitOffset>=returnStart&&entry.unitOffset<returnEnd).map((entry)=>entry.serial);
    for(const serialValue of returnedSerials){
      const updated=await client.query(`UPDATE product_serials SET status='IN_STOCK',sale_id=NULL,store_id=$4,updated_at=now() WHERE organization_id=$1 AND product_id=$2 AND lower(serial)=lower($3) AND sale_id=$5 AND status='SOLD'`,[orgId,input.productId,serialValue,sale.store_id,sale.id]);
      if(!updated.rowCount)throw new HttpError(409,`Serial/IMEI ${serialValue} ushbu savdoda topilmadi`,`SERIAL_NOT_IN_SALE`);
    }
    const restoredBatches=await restoreInventoryBatches(client,{organizationId:orgId,storeId:sale.store_id,productId:input.productId,tracking,returnStart,returnEnd});
    if(returnedSerials.length||restoredBatches.length)await client.query(`UPDATE sale_returns SET metadata=metadata||$2::jsonb WHERE id=$1`,[ret.id,JSON.stringify({tracking:{serials:returnedSerials,batches:restoredBatches}})]);
    const store=await assertOrganizationStore(client,orgId,sale.store_id);
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:sale.store_id,action:"return",entityType:"sale",entityId:ret.id,title:"Qaytarish qilindi",description:`${sale.sale_number} · ${item.product_name||input.productId} · ${input.quantity} · ${amount}`,metadata:{saleId:sale.id,saleNumber:sale.sale_number,productId:input.productId,productName:item.product_name||"",quantity:input.quantity,amount,refundBreakdown:breakdown,reason:input.reason}});
    await enqueueNotification(client,{organizationId:orgId,storeId:sale.store_id,eventType:"sale.returned",eventId:ret.id,payload:{returnId:ret.id,saleId:sale.id,saleNumber:sale.sale_number,amount,quantity:input.quantity,storeName:store.name,userName:req.user.name,reason:input.reason}});
    return {...ret,amount,refundBreakdown:breakdown};
  });
  ok(res,{return:result},201);
}));

export default router;
