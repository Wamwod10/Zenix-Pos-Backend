import express, { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { pool } from "../db/pool.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission } from "../middleware/auth.js";
import {
  BILLING_PLANS, addMonths, daysBetween, dateISO, extraStoreExtensionPrice, makeBillingOrderId,
  planExtensionPrice,
} from "../config/billing.js";
import { databaseDateISO, organizationCalendarDateISO } from "../lib/businessDate.js";
import { writeAudit } from "../services/audit.js";
import { ACCEPTED_RECEIPT_TYPES, isReceiptConsistent } from "../lib/receiptType.js";
import { enqueuePaymentReviewNotification } from "../services/paymentNotifications.js";
import { buildBillingDraftMetadata } from "../services/billingDraftMetadata.js";
import { assertBillingDraftCurrent, draftRecalculationInput } from "../services/billingDraftIntegrity.js";
import { assertNoConflictingBillingReview } from "../services/pendingBillingReview.js";
import { assertReceiptAvailable } from "../services/receiptReuseGuard.js";
import { lockValidPromo,consumePromo,discountForAmount,reservePromo } from "../services/promoCodes.js";

const router=Router();
router.use(requireAuth,requireOrganization);

const ACCEPTED_RECEIPTS=new Set(ACCEPTED_RECEIPT_TYPES);
const MAX_RECEIPT_BYTES=5*1024*1024;
export const draftSchema=z.object({
  type:z.enum(["LICENSE","EXTRA"]),
  plan:z.enum(["MONTHLY","ANNUAL"]).optional(),
  intent:z.enum(["ACTIVATE","RENEW","CHANGE_PLAN","EXTRA"]).optional(),
  selectedEndDate:z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(value=>dateISO(value)===value,'Sana noto‘g‘ri').optional().nullable(),
  extraStoreCount:z.coerce.number().int().min(0).max(20).default(0),
  promoCode:z.string().trim().max(40).default(""),
  metadata:z.record(z.string(),z.any()).default({}),
}).superRefine((input,ctx)=>{
  if(input.type==="EXTRA" && input.intent && input.intent!=="EXTRA"){
    ctx.addIssue({code:"custom",path:["intent"],message:"Filial uchun noto‘g‘ri to‘lov maqsadi"});
  }
  if(input.type==="LICENSE" && input.intent==="EXTRA"){
    ctx.addIssue({code:"custom",path:["intent"],message:"Tarif uchun noto‘g‘ri to‘lov maqsadi"});
  }
});

const publicDraft=(row)=>{
  if(!row)return null;
  const intent=row.metadata?.intent||(row.type==="EXTRA"?"EXTRA":"RENEW");
  const purpose=row.metadata?.purpose||(row.type==="EXTRA"?`Qo‘shimcha filial limiti · ${row.extra_store_count} ta`:`${BILLING_PLANS[row.plan]?.label||row.plan} tarif`);
  return {
    id:row.id,orderId:row.order_id,type:row.type,plan:row.plan,intent,
    currentEndDate:row.current_end_date,selectedEndDate:row.selected_end_date,
    extensionDays:Number(row.extension_days||0),baseAmount:Number(row.base_amount||0),
    extraStoreCount:Number(row.extra_store_count||0),extraStoreAmount:Number(row.extra_store_amount||0),
    totalAmount:Number(row.total_amount||0),metadata:row.metadata||{},status:row.status,expiresAt:row.expires_at,
    order:{
      id:row.order_id,orderId:row.order_id,type:row.type,plan:row.plan,intent,
      amount:Number(row.total_amount||0),baseAmount:Number(row.base_amount||0),extraStoreAmount:Number(row.extra_store_amount||0),
      extraStores:Number(row.extra_store_count||0),renewalExtraStores:row.type==="LICENSE"?Number(row.extra_store_count||0):0,
      currentExpiry:row.current_end_date,servicePeriodFrom:row.current_end_date,servicePeriodTo:row.selected_end_date,targetExpiry:row.selected_end_date,
      extensionDays:Number(row.extension_days||0),purpose,status:"PENDING",
    },
  };
};

const publicPayment=(row)=>row?({
  id:row.id,orderId:row.order_id,organizationId:row.organization_id,draftId:row.draft_id,type:row.type,plan:row.plan,
  amount:Number(row.amount||0),status:row.status,servicePeriodFrom:row.service_period_from,servicePeriodTo:row.service_period_to,
  targetExpiry:row.service_period_to,extensionDays:Number(row.extension_days||0),extraStores:Number(row.extra_store_count||0),
  renewalExtraStores:Number(row.extra_store_count||0),receiptId:row.receipt_id,receiptName:row.receipt_name,receiptType:row.receipt_type,
  rejectReason:row.reject_reason||"",submittedAt:row.submitted_at,reviewedAt:row.reviewed_at,
}):null;

export async function calculateDraft(client,user,input,{lockPromo=true}={}){
  const org=(await client.query("SELECT * FROM organizations WHERE id=$1 FOR UPDATE",[user.organizationId])).rows[0];
  if(!org)throw new HttpError(404,"Tashkilot topilmadi");
  const activeStores=Number((await client.query("SELECT count(*)::int AS count FROM stores WHERE organization_id=$1 AND active=true",[user.organizationId])).rows[0]?.count||0);
  const today=organizationCalendarDateISO(org);
  const currentExpiry=org.expiry_date?databaseDateISO(org.expiry_date):null;
  const futureExpiry=currentExpiry&&currentExpiry>today?currentExpiry:today;
  const requestedPlan=input.plan||org.plan||"ANNUAL";
  let plan=BILLING_PLANS[requestedPlan]?requestedPlan:"ANNUAL";
  const selectedPlan=BILLING_PLANS[plan];
  let intent=input.intent||(input.type==="EXTRA"?"EXTRA":"RENEW");
  let currentEndDate=futureExpiry;
  let selectedEndDate=input.selectedEndDate||null;
  let extensionDays=0;
  let baseAmount=0;
  let extraStoreCount=Math.max(0,Number(input.extraStoreCount||0));
  let extraStoreAmount=0;

  if(input.type==="EXTRA"){
    intent="EXTRA";
    const orgPlan=BILLING_PLANS[org.plan]?org.plan:"ANNUAL";
    if(!currentExpiry||currentExpiry<=today)throw new HttpError(409,"Faol tarif topilmadi. Avval tarifni aktivlashtiring.","LICENSE_REQUIRED");
    currentEndDate=today;selectedEndDate=currentExpiry;extensionDays=daysBetween(today,currentExpiry);
    extraStoreCount=Math.max(1,extraStoreCount||1);
    baseAmount=0;extraStoreAmount=extraStoreExtensionPrice(orgPlan,extensionDays,extraStoreCount);
  }else if(intent==="RENEW"){
    const renewalPlan=BILLING_PLANS[org.plan]?org.plan:plan;
    plan=renewalPlan;
    currentEndDate=futureExpiry;
    if(!selectedEndDate||selectedEndDate<=currentEndDate)throw new HttpError(400,"Uzaytirish sanasi joriy davr tugashidan keyin bo‘lishi kerak","INVALID_RENEWAL_DATE");
    extensionDays=daysBetween(currentEndDate,selectedEndDate);
    const minimumExtras=Math.max(0,activeStores-BILLING_PLANS[renewalPlan].includedStores);
    extraStoreCount=Math.max(minimumExtras,extraStoreCount);
    baseAmount=planExtensionPrice(renewalPlan,extensionDays);
    extraStoreAmount=extraStoreExtensionPrice(renewalPlan,extensionDays,extraStoreCount);

  }else{
    currentEndDate=futureExpiry;
    selectedEndDate=addMonths(currentEndDate,selectedPlan.months);
    extensionDays=daysBetween(currentEndDate,selectedEndDate);
    const minimumExtras=Math.max(0,activeStores-selectedPlan.includedStores);
    extraStoreCount=Math.max(minimumExtras,extraStoreCount);
    baseAmount=selectedPlan.amount;
    extraStoreAmount=selectedPlan.extraStoreAmount*extraStoreCount;
  }
  let promoId=null,promoDiscount=0,promoDiscountPercent=0,promoCode="";
  if(input.promoCode){
    if(input.type!=="LICENSE")throw new HttpError(400,"Promokod faqat tarif uchun qo‘llanadi","PROMO_LICENSE_ONLY");
    const promo=await lockValidPromo(client,{code:input.promoCode,plan,organizationId:user.organizationId,lock:lockPromo});
    promoId=promo.id;promoCode=promo.code;promoDiscountPercent=Number(promo.discount_percent);
    promoDiscount=discountForAmount(baseAmount,promoDiscountPercent);
    if(promoDiscount>=baseAmount)throw new HttpError(400,"100% promokodni bepul faollashtirish oynasida ishlating","PROMO_FREE_FLOW");
  }
  return {type:input.type,plan:input.type==="EXTRA"?(BILLING_PLANS[org.plan]?org.plan:"ANNUAL"):plan,intent,currentEndDate,selectedEndDate,extensionDays,baseAmount,extraStoreCount,extraStoreAmount,totalAmount:baseAmount+extraStoreAmount-promoDiscount,activeStores,promoId,promoCode,promoDiscount,promoDiscountPercent};
}

router.post("/promo/preview",requirePermission("moduleBilling"),asyncRoute(async(req,res)=>{
 const input=z.object({code:z.string().min(4).max(40),plan:z.enum(["MONTHLY","ANNUAL"])}).parse(req.body);
 const result=await withTransaction(async(client)=>{
   await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[req.user.organizationId]);
   const promo=await lockValidPromo(client,{code:input.code,plan:input.plan,organizationId:req.user.organizationId});
   const original=BILLING_PLANS[input.plan].amount,discount=discountForAmount(original,promo.discount_percent);
   return {code:promo.code,plan:input.plan,percent:promo.discount_percent,original,discount,due:original-discount};
 });ok(res,{promo:result});
}));
router.post("/promo/redeem-free",requirePermission("billingWrite"),asyncRoute(async(req,res)=>{
 const input=z.object({code:z.string().min(4).max(40),plan:z.enum(["MONTHLY","ANNUAL"])}).parse(req.body);
 const result=await withTransaction(async(client)=>{
   const org=(await client.query("SELECT * FROM organizations WHERE id=$1 FOR UPDATE",[req.user.organizationId])).rows[0];
   if(!org)throw new HttpError(404,"Biznes topilmadi");
   if(org.license_status==="SUSPENDED")throw new HttpError(409,"Akkaunt administrator tomonidan bloklangan","ORG_SUSPENDED");
   const pending=(await client.query("SELECT 1 FROM billing_payments WHERE organization_id=$1 AND status='REVIEW' LIMIT 1",[org.id])).rowCount;
   if(pending)throw new HttpError(409,"To‘lov tekshiruvi tugashini kuting","PAYMENT_REVIEW_PENDING");
   const promo=await lockValidPromo(client,{code:input.code,plan:input.plan,organizationId:org.id});
   if(Number(promo.discount_percent)!==100)throw new HttpError(409,"Bu promokod faqat chegirma beradi; to‘lovni davom ettiring","PROMO_PAYMENT_REQUIRED");
   const today=organizationCalendarDateISO(org);
   const base=org.expiry_date&&databaseDateISO(org.expiry_date)>today?databaseDateISO(org.expiry_date):today;
   const until=addMonths(base,BILLING_PLANS[input.plan].months);
   await consumePromo(client,{promo,organizationId:org.id,plan:input.plan,discountAmount:BILLING_PLANS[input.plan].amount});
   await client.query("UPDATE organizations SET license_status='ACTIVE',plan=$2,expiry_date=$3,settings=jsonb_set(COALESCE(settings,'{}'::jsonb),'{billingHold}','false'::jsonb,true),updated_at=now() WHERE id=$1",[org.id,input.plan,until]);
   await writeAudit(client,{organizationId:org.id,userId:req.user.id,action:'redeem',entityType:'promo',entityId:promo.id,title:'Bepul promokod faollashtirildi',description:`${promo.code} · ${input.plan} · ${until}`});
   return {plan:input.plan,expiryDate:until};
 });ok(res,{subscription:result});
}));

router.get("/draft",requirePermission("moduleBilling"),asyncRoute(async(req,res)=>{
  const {rows}=await pool.query("SELECT * FROM billing_drafts WHERE organization_id=$1 AND created_by=$2 AND status='open' AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[req.user.organizationId,req.user.id]);
  ok(res,{draft:publicDraft(rows[0]||null)});
}));

router.post("/draft",requirePermission("billingWrite"),asyncRoute(async(req,res)=>{
  const input=draftSchema.parse(req.body);
  const row=await withTransaction(async(client)=>{
    const calculated=await calculateDraft(client,req.user,input);
    await client.query("UPDATE billing_drafts SET status='cancelled' WHERE organization_id=$1 AND created_by=$2 AND status='open'",[req.user.organizationId,req.user.id]);
    const orderId=makeBillingOrderId();
    const metadata=buildBillingDraftMetadata(input,calculated);
    return (await client.query(`INSERT INTO billing_drafts(order_id,organization_id,created_by,type,plan,current_end_date,selected_end_date,extension_days,base_amount,extra_store_count,extra_store_amount,total_amount,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[
      orderId,req.user.organizationId,req.user.id,calculated.type,calculated.plan,calculated.currentEndDate,calculated.selectedEndDate,
      calculated.extensionDays,calculated.baseAmount,calculated.extraStoreCount,calculated.extraStoreAmount,calculated.totalAmount,metadata,
    ])).rows[0];
  });
  ok(res,{draft:publicDraft(row)},201);
}));

router.post("/draft/:id/cancel",requirePermission("billingWrite"),asyncRoute(async(req,res)=>{
  await pool.query("UPDATE billing_drafts SET status='cancelled' WHERE id=$1 AND organization_id=$2 AND created_by=$3 AND status='open'",[req.params.id,req.user.organizationId,req.user.id]);
  ok(res,{cancelled:true});
}));

router.post("/receipts",requirePermission("billingWrite"),express.raw({type:[...ACCEPTED_RECEIPTS],limit:"5mb"}),asyncRoute(async(req,res)=>{
  const mime=String(req.get("content-type")||"").split(";")[0].trim().toLowerCase();
  if(!ACCEPTED_RECEIPTS.has(mime))throw new HttpError(415,"Faqat JPG, PNG yoki PDF qabul qilinadi","UNSUPPORTED_RECEIPT_TYPE");
  if(!Buffer.isBuffer(req.body)||req.body.length<=0)throw new HttpError(400,"Chek fayli bo‘sh","EMPTY_RECEIPT");
  if(req.body.length>MAX_RECEIPT_BYTES)throw new HttpError(413,"Chek hajmi 5MB dan oshmasligi kerak","RECEIPT_TOO_LARGE");
  if(!isReceiptConsistent(req.body,mime))throw new HttpError(415,"Chek fayli ko‘rsatilgan turga mos kelmaydi","RECEIPT_CONTENT_MISMATCH");
  let fileName="receipt";
  try{fileName=decodeURIComponent(String(req.get("x-file-name")||"receipt")).slice(0,250)}catch{fileName=String(req.get("x-file-name")||"receipt").slice(0,250)}
  const row=(await pool.query(`INSERT INTO billing_receipts(organization_id,uploaded_by,file_name,mime_type,file_size,content) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,file_name,mime_type,file_size,created_at`,[req.user.organizationId,req.user.id,fileName,mime,req.body.length,req.body])).rows[0];
  ok(res,{receipt:{id:row.id,fileName:row.file_name,mimeType:row.mime_type,fileSize:row.file_size,createdAt:row.created_at}},201);
}));

router.get("/receipts/:id",requirePermission("moduleBilling"),asyncRoute(async(req,res)=>{
  const row=(await pool.query("SELECT file_name,mime_type,content FROM billing_receipts WHERE id=$1 AND organization_id=$2",[req.params.id,req.user.organizationId])).rows[0];
  if(!row)throw new HttpError(404,"Chek topilmadi");
  res.setHeader("Content-Type",row.mime_type);res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);res.setHeader("Cache-Control","private, max-age=60");res.send(row.content);
}));

router.delete("/receipts/:id",requirePermission("billingWrite"),asyncRoute(async(req,res)=>{
  const result=await pool.query(`DELETE FROM billing_receipts r WHERE r.id=$1 AND r.organization_id=$2 AND NOT EXISTS (SELECT 1 FROM billing_payments p WHERE p.receipt_id=r.id)`,[req.params.id,req.user.organizationId]);
  if(!result.rowCount)throw new HttpError(409,"Chek to‘lovda ishlatilmoqda yoki topilmadi","RECEIPT_IN_USE");
  ok(res,{deleted:true});
}));

router.post("/payments",requirePermission("billingWrite"),asyncRoute(async(req,res)=>{
  const input=z.object({draftId:z.string().uuid(),receiptId:z.string().uuid()}).parse(req.body);
  const payment=await withTransaction(async(client)=>{
    // Lock the organization first, as in /draft and platform controls, to avoid
    // deadlocks and to keep approval/submission decisions on a consistent quote.
    const owner=(await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[req.user.organizationId])).rows[0];
    if(!owner)throw new HttpError(404,"Tashkilot topilmadi","ORG_NOT_FOUND");
    const existing=(await client.query(`SELECT * FROM billing_payments
      WHERE organization_id=$1 AND draft_id=$2 AND submitted_by=$3 FOR UPDATE`,[req.user.organizationId,input.draftId,req.user.id])).rows[0];
    if(existing){
      if(existing.receipt_id!==input.receiptId)throw new HttpError(409,"Bu hisob boshqa chek bilan yuborilgan","BILLING_PAYMENT_ALREADY_SUBMITTED");
      return existing;
    }
    const draft=(await client.query("SELECT * FROM billing_drafts WHERE id=$1 AND organization_id=$2 AND created_by=$3 AND status='open' AND expires_at>now() FOR UPDATE",[input.draftId,req.user.organizationId,req.user.id])).rows[0];
    if(!draft)throw new HttpError(409,"To‘lov drafti topilmadi yoki muddati tugagan","BILLING_DRAFT_EXPIRED");
    // Reprice on the locked organization; a stale draft must never bypass the
    // current tariff, branch count or effective expiry date.
    // Capacity is decided after the new payment is locked: organization -> payment -> promo.
    const refreshed=await calculateDraft(client,req.user,draftRecalculationInput(draft),{lockPromo:false});
    assertBillingDraftCurrent(draft,refreshed);
    const receipt=(await client.query("SELECT id,file_name,mime_type FROM billing_receipts WHERE id=$1 AND organization_id=$2 FOR UPDATE",[input.receiptId,req.user.organizationId])).rows[0];
    if(!receipt)throw new HttpError(404,"To‘lov cheki topilmadi","RECEIPT_NOT_FOUND");
    // The locked organization row serializes all pending reviews, including
    // opposite payment types. They both mutate the same store_limit.
    await assertNoConflictingBillingReview(client,req.user.organizationId);
    await assertReceiptAvailable(client,{organizationId:req.user.organizationId,receiptId:receipt.id});
    const p=(await client.query(`INSERT INTO billing_payments(organization_id,draft_id,order_id,type,plan,amount,service_period_from,service_period_to,extension_days,extra_store_count,receipt_id,receipt_name,receipt_type,submitted_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[
      req.user.organizationId,draft.id,draft.order_id,draft.type,draft.plan,draft.total_amount,draft.current_end_date,draft.selected_end_date,draft.extension_days,draft.extra_store_count,
      receipt.id,receipt.file_name,receipt.mime_type,req.user.id,
    ])).rows[0];
    await reservePromo(client,{paymentId:p.id,organizationId:req.user.organizationId});
    await enqueuePaymentReviewNotification(client,p);
    await client.query("UPDATE billing_drafts SET status='submitted',updated_at=now() WHERE id=$1",[draft.id]);
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"submit",entityType:"billing_payment",entityId:p.id,title:"To‘lov tekshiruvga yuborildi",description:`${p.order_id} · ${Number(p.amount)}`});
    return p;
  });
  ok(res,{payment:publicPayment(payment)},201);
}));

export default router;
