import {requestFingerprint} from "../services/posReplay.js";
import {sumMoney,roundMoney} from "../lib/posMoney.js";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { hasPermission } from "../lib/permissions.js";
import { writeAudit } from "../services/audit.js";
import { assertOrganizationStore, scopedStoreId } from "../lib/storeScope.js";
import { parseCustomerDirectoryQuery, buildCustomerPageQuery, customerFinancialJoin as financialJoin, parseCustomerHistoryQuery, buildCustomerHistoryQuery } from "../services/customerDirectory.js";

const router=Router();
router.use(requireAuth,requireOrganization,requireActiveLicense,requirePermission("moduleSales"));
const customerFields={name:z.string().trim().min(2).max(160),phone:z.string().trim().max(60),email:z.string().trim().max(160),address:z.string().trim().max(300),customerType:z.enum(["REGULAR","VIP","WHOLESALE"]),creditLimit:z.coerce.number().min(0),defaultCreditDays:z.coerce.number().int().min(0).max(3650),note:z.string().max(1000),loyaltyTier:z.enum(["STANDARD","SILVER","GOLD","VIP"]),tags:z.array(z.string().trim().min(1).max(40)).max(20)};
const customerSchema=z.object(customerFields).extend({phone:customerFields.phone.default(""),email:customerFields.email.default(""),address:customerFields.address.default(""),customerType:customerFields.customerType.default("REGULAR"),creditLimit:customerFields.creditLimit.default(0),defaultCreditDays:customerFields.defaultCreditDays.default(0),note:customerFields.note.default(""),loyaltyTier:customerFields.loyaltyTier.default("STANDARD"),tags:customerFields.tags.default([])});
const customerPatchSchema=z.object(customerFields).partial();
export const parseCustomerPatch=(value)=>customerPatchSchema.parse(value);
const paymentSchema=z.object({clientReference:z.string().trim().max(160).default(""),amount:z.coerce.number().positive().max(9000000000000).refine(value=>roundMoney(value)===value,"Summa 2 kasr xonadan oshmasin"),paymentMethod:z.enum(["cash","card","transfer"]),storeId:z.string().uuid().optional().nullable(),note:z.string().max(500).default("")});
const normalizeCustomerPhone=(value)=>String(value||"").replace(/\D/g,"");
async function assertUniqueCustomerPhone(client,{organizationId,phone,excludeId=null}){
  const normalized=normalizeCustomerPhone(phone);
  if(!normalized)return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`customer-phone:${organizationId}:${normalized}`]);
  const existing=(await client.query("SELECT id,name FROM customers WHERE organization_id=$1 AND archived=false AND regexp_replace(phone, '[^0-9]', '', 'g')=$2 AND ($3::uuid IS NULL OR id<>$3) LIMIT 1",[organizationId,normalized,excludeId])).rows[0];
  if(existing)throw new HttpError(409,"Bu telefon raqami bilan mijoz allaqachon mavjud","CUSTOMER_PHONE_EXISTS",{customerId:existing.id,customerName:existing.name});
}
const view=(r)=>({id:r.id,name:r.name,phone:r.phone,email:r.email,address:r.address,customerType:r.customer_type,creditLimit:Number(r.credit_limit||0),defaultCreditDays:Number(r.default_credit_days||0),note:r.note||"",loyaltyTier:r.loyalty_tier||"STANDARD",tags:r.tags||[],archived:Boolean(r.archived),balance:Number(r.balance||0),overdue:Number(r.overdue||0),totalPurchases:Number(r.total_purchases||0),saleCount:Number(r.sale_count||0),lastPurchaseAt:r.last_purchase_at||null,loyaltyPoints:Number(r.loyalty_points||0),createdAt:r.created_at});
const ledgerView=(x)=>({id:x.id,type:x.entry_type,amount:Number(x.amount),allocated:Number(x.allocated||0),openAmount:x.entry_type==="CREDIT_SALE"?Math.max(0,Number(x.amount)-Number(x.allocated||0)):0,dueDate:x.due_date,paymentMethod:x.payment_method,reference:x.reference,note:x.note,createdAt:x.created_at});

const tagSchema=z.array(z.string().trim().min(1).max(40).refine(value=>!value.includes(','),'Tag cannot contain comma')).max(20).transform(values=>[...new Set(values)]);
const configuredTags=user=>tagSchema.catch([]).parse(user.organizationSettings?.customerTags||[]);
function validateTagChange(req,input,current=[]){
 if(input.tags===undefined||JSON.stringify(input.tags)===JSON.stringify(current))return;
 if(!hasPermission(req.user,'settingsWrite'))throw new HttpError(403,'Taglarni tahrirlash uchun ruxsat yoq','FORBIDDEN');
 const allowed=new Set([...configuredTags(req.user),...current]);
 if(input.tags.some(tag=>!allowed.has(tag)))throw new HttpError(400,'Tag sozlamalarda mavjud emas','CUSTOMER_TAG_NOT_ALLOWED');
}
router.get('/tags',asyncRoute(async(req,res)=>{
 const existing=(await pool.query('SELECT DISTINCT unnest(tags) tag FROM customers WHERE organization_id=$1 ORDER BY tag',[req.user.organizationId])).rows.map(row=>row.tag);
 ok(res,{configured:configuredTags(req.user),existing});
}));
router.patch('/tags',requirePermission('settingsWrite'),asyncRoute(async(req,res)=>{
 const tags=tagSchema.parse(req.body.tags);
 await withTransaction(async client=>{
  await client.query("UPDATE organizations SET settings=jsonb_set(COALESCE(settings,'{}'::jsonb),'{customerTags}',$2::jsonb),updated_at=now() WHERE id=$1",[req.user.organizationId,JSON.stringify(tags)]);
  await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:'update',entityType:'customer_tags',title:'CRM tag configuration',description:tags.join(', ')});
 });ok(res,{configured:tags});
}));
router.get("/stats",asyncRoute(async(req,res)=>{
  const org=req.user.organizationId;
  const summary=(await pool.query(`SELECT count(*) FILTER(WHERE archived=false) customers,COALESCE((SELECT sum(amount) FROM customer_ledger WHERE organization_id=$1),0) balance,COALESCE((SELECT sum(GREATEST(cl.amount-COALESCE(a.allocated,0),0)) FROM customer_ledger cl LEFT JOIN (SELECT credit_ledger_id,sum(amount) allocated FROM customer_payment_allocations WHERE organization_id=$1 GROUP BY credit_ledger_id) a ON a.credit_ledger_id=cl.id WHERE cl.organization_id=$1 AND cl.entry_type='CREDIT_SALE' AND cl.due_date<CURRENT_DATE),0) overdue FROM customers WHERE organization_id=$1`,[org])).rows[0];
  const aging=(await pool.query(`SELECT bucket,COALESCE(sum(open_amount),0) amount,count(*) FILTER(WHERE open_amount>0) accounts FROM (SELECT CASE WHEN CURRENT_DATE-cl.due_date<=7 THEN '0_7' WHEN CURRENT_DATE-cl.due_date<=30 THEN '8_30' WHEN CURRENT_DATE-cl.due_date<=60 THEN '31_60' ELSE '60_plus' END bucket,GREATEST(cl.amount-COALESCE(a.allocated,0),0) open_amount FROM customer_ledger cl LEFT JOIN (SELECT credit_ledger_id,sum(amount) allocated FROM customer_payment_allocations WHERE organization_id=$1 GROUP BY credit_ledger_id) a ON a.credit_ledger_id=cl.id WHERE cl.organization_id=$1 AND cl.entry_type='CREDIT_SALE' AND cl.due_date<CURRENT_DATE) x GROUP BY bucket`,[org])).rows;
  ok(res,{customers:Number(summary.customers||0),balance:Number(summary.balance||0),overdue:Number(summary.overdue||0),aging:Object.fromEntries(aging.map(x=>[x.bucket,{amount:Number(x.amount),accounts:Number(x.accounts)}]))});
}));
router.get('/export',requirePermission('settingsWrite'),asyncRoute(async(req,res)=>{
 const input=parseCustomerDirectoryQuery({...req.query,limit:100,offset:0});
 const query=buildCustomerPageQuery({organizationId:req.user.organizationId,...input});query.values[2]=10001;
 const {rows}=await pool.query(query.text,query.values);
 if(rows.filter(row=>row.id).length>10000)throw new HttpError(413,'Eksport uchun filtrni toraytiring: maksimum 10000 mijoz','EXPORT_LIMIT');
 await withTransaction(client=>writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:'export',entityType:'customer',title:'CRM eksport',description:`${rows.filter(row=>row.id).length} ta mijoz`}));
 ok(res,{items:rows.filter(row=>row.id).map(view)});
}));
router.get("/",asyncRoute(async(req,res)=>{
  const input=parseCustomerDirectoryQuery(req.query);
  const query=buildCustomerPageQuery({organizationId:req.user.organizationId,...input});
  const {rows}=await pool.query(query.text,query.values);
  // The count survives an empty page; its left-join sentinel is not a customer.
  ok(res,{items:rows.filter(row=>row.id).map(view),total:Number(rows[0]?.total||0),limit:input.limit,offset:input.offset});
}));
router.post("/",asyncRoute(async(req,res)=>{const input=customerSchema.parse(req.body);validateTagChange(req,input);const customer=await withTransaction(async(client)=>{await assertUniqueCustomerPhone(client,{organizationId:req.user.organizationId,phone:input.phone});const row=(await client.query(`INSERT INTO customers(organization_id,name,phone,email,address,customer_type,credit_limit,default_credit_days,note,loyalty_tier,tags,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[req.user.organizationId,input.name,input.phone,input.email,input.address,input.customerType,input.creditLimit,input.defaultCreditDays,input.note,input.loyaltyTier,input.tags,req.user.id])).rows[0];await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"create",entityType:"customer",entityId:row.id,title:"Mijoz yaratildi",description:row.name});return row});ok(res,{customer:view(customer)},201)}));
router.patch("/:id",asyncRoute(async(req,res)=>{const input=parseCustomerPatch(req.body);const row=await withTransaction(async(client)=>{const current=(await client.query("SELECT * FROM customers WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.user.organizationId])).rows[0];if(!current)throw new HttpError(404,"Mijoz topilmadi");validateTagChange(req,input,current.tags||[]);const next={name:input.name??current.name,phone:input.phone??current.phone,email:input.email??current.email,address:input.address??current.address,customerType:input.customerType??current.customer_type,creditLimit:input.creditLimit??current.credit_limit,defaultCreditDays:input.defaultCreditDays??current.default_credit_days,note:input.note??current.note,loyaltyTier:input.loyaltyTier??current.loyalty_tier,tags:input.tags??current.tags};await assertUniqueCustomerPhone(client,{organizationId:req.user.organizationId,phone:next.phone,excludeId:current.id});const updated=(await client.query(`UPDATE customers SET name=$3,phone=$4,email=$5,address=$6,customer_type=$7,credit_limit=$8,default_credit_days=$9,note=$10,loyalty_tier=$11,tags=$12,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`,[req.params.id,req.user.organizationId,next.name,next.phone,next.email,next.address,next.customerType,next.creditLimit,next.defaultCreditDays,next.note,next.loyaltyTier,next.tags])).rows[0];await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"update",entityType:"customer",entityId:updated.id,title:"Mijoz yangilandi",description:updated.name});return updated});ok(res,{customer:view(row)})}));
const historyViews={
 ledger:ledgerView,'open-credits':ledgerView,
 sales:x=>({id:x.id,saleNumber:x.sale_number,total:Number(x.total),returnedTotal:Number(x.returned_amount),netTotal:sumMoney([Number(x.total),-Number(x.returned_amount)]),status:x.status,createdAt:x.created_at,businessDate:x.business_date}),
 returns:r=>({id:r.id,saleId:r.sale_id,saleNumber:r.sale_number,productName:r.product_name,quantity:Number(r.quantity),amount:Number(r.amount),reason:r.reason,refundMethod:r.refund_method,createdAt:r.created_at}),
};
async function historyPage(req,kind,input){
 const storeId=scopedStoreId(req.user,input.storeId);
 if(storeId)await assertOrganizationStore(pool,req.user.organizationId,storeId,{activeOnly:false});
 const query=buildCustomerHistoryQuery({organizationId:req.user.organizationId,customerId:req.params.id,storeId,kind,limit:input.limit,offset:input.offset});
 const {rows}=await pool.query(query.text,query.values);
 const hasMore=rows.length>input.limit;
 return {items:rows.slice(0,input.limit).map(historyViews[kind]),limit:input.limit,offset:input.offset,hasMore,nextOffset:hasMore?input.offset+input.limit:null};
}
for(const kind of Object.keys(historyViews))router.get('/:id/'+kind,asyncRoute(async(req,res)=>{
 const input=parseCustomerHistoryQuery(req.query);
 const customer=(await pool.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2',[req.user.organizationId,z.string().uuid().parse(req.params.id)])).rows[0];
 if(!customer)throw new HttpError(404,'Mijoz topilmadi');
 ok(res,await historyPage(req,kind,input));
}));
router.get("/:id",asyncRoute(async(req,res)=>{
 const input=z.object({ledgerLimit:z.coerce.number().int().min(1).max(100).default(50),salesLimit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
 z.string().uuid().parse(req.params.id);
 const row=(await pool.query(`SELECT c.*,COALESCE(l.balance,0) balance,COALESCE(od.overdue,0) overdue,COALESCE(s.total_purchases,0) total_purchases,COALESCE(s.sale_count,0) sale_count,s.last_purchase_at,COALESCE(lp.loyalty_points,0) loyalty_points FROM customers c ${financialJoin} WHERE c.id=$2 AND c.organization_id=$1`,[req.user.organizationId,req.params.id])).rows[0];
 if(!row)throw new HttpError(404,'Mijoz topilmadi');
 const [ledger,sales,credits,returns]=await Promise.all([historyPage(req,'ledger',{limit:input.ledgerLimit,offset:0}),historyPage(req,'sales',{limit:input.salesLimit,offset:0}),historyPage(req,'open-credits',{limit:50,offset:0}),historyPage(req,'returns',{limit:50,offset:0})]);
 ok(res,{customer:view(row),ledger:ledger.items,sales:sales.items,openCredits:credits.items,returns:returns.items,pagination:{ledgerHasMore:ledger.hasMore,salesHasMore:sales.hasMore,openCreditsHasMore:credits.hasMore,returnsHasMore:returns.hasMore},pages:{ledger,sales,openCredits:credits,returns}});
}));
router.post("/:id/payments",asyncRoute(async(req,res)=>{const input=paymentSchema.parse(req.body);const storeId=scopedStoreId(req.user,input.storeId);const entry=await withTransaction(async(client)=>{const fingerprint=requestFingerprint({customerId:req.params.id,userId:req.user.id,...input,storeId});if(input.clientReference){await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`customer-payment:${req.user.organizationId}:${input.clientReference}`]);const previous=(await client.query("SELECT * FROM customer_ledger WHERE organization_id=$1 AND entry_type='PAYMENT' AND metadata->>'clientReference'=$2",[req.user.organizationId,input.clientReference])).rows[0];if(previous){if(previous.customer_id!==req.params.id||previous.metadata?.fingerprint!==fingerprint)throw new HttpError(409,"Payment reference conflict","IDEMPOTENCY_CONFLICT");return previous;}}if(storeId)await assertOrganizationStore(client,req.user.organizationId,storeId);const customer=(await client.query("SELECT * FROM customers WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.user.organizationId])).rows[0];if(!customer)throw new HttpError(404,"Mijoz topilmadi");const balance=Number((await client.query("SELECT COALESCE(sum(amount),0) balance FROM customer_ledger WHERE organization_id=$1 AND customer_id=$2",[req.user.organizationId,customer.id])).rows[0].balance||0);if(input.amount>balance)throw new HttpError(409,"To‘lov joriy qarzdan katta","CUSTOMER_PAYMENT_EXCEEDS_BALANCE",{balance});const row=(await client.query(`INSERT INTO customer_ledger(organization_id,customer_id,store_id,entry_type,amount,payment_method,note,created_by,metadata) VALUES($1,$2,$3,'PAYMENT',$4,$5,$6,$7,$8) RETURNING *`,[req.user.organizationId,customer.id,storeId,-input.amount,input.paymentMethod,input.note,req.user.id,{clientReference:input.clientReference,fingerprint}])).rows[0];let remaining=input.amount;const credits=(await client.query(`SELECT cl.id,GREATEST(cl.amount-COALESCE(sum(a.amount),0),0) open_amount FROM customer_ledger cl LEFT JOIN customer_payment_allocations a ON a.credit_ledger_id=cl.id WHERE cl.organization_id=$1 AND cl.customer_id=$2 AND cl.entry_type='CREDIT_SALE' GROUP BY cl.id ORDER BY cl.due_date NULLS LAST,cl.created_at`,[req.user.organizationId,customer.id])).rows;for(const credit of credits){if(remaining<=0)break;const amount=Math.min(remaining,Number(credit.open_amount||0));if(amount<=0)continue;await client.query(`INSERT INTO customer_payment_allocations(organization_id,customer_id,payment_ledger_id,credit_ledger_id,amount) VALUES($1,$2,$3,$4,$5)`,[req.user.organizationId,customer.id,row.id,credit.id,amount]);remaining=sumMoney([remaining,-amount]);}await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId,action:"create",entityType:"customer_payment",entityId:row.id,title:"Nasiya to‘lovi qabul qilindi",description:`${customer.name} · ${input.amount}`});return row});ok(res,{payment:{id:entry.id,amount:Math.abs(Number(entry.amount)),paymentMethod:entry.payment_method,createdAt:entry.created_at}})}));
export default router;
