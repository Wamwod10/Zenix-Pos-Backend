import express, { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { pool } from "../db/pool.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission } from "../middleware/auth.js";
import {
  BILLING_PLANS, addMonths, daysBetween, extraStoreExtensionPrice, makeBillingOrderId,
  planExtensionPrice,
} from "../config/billing.js";
import { organizationCalendarDateISO } from "../lib/businessDate.js";
import { writeAudit } from "../services/audit.js";

const router=Router();
router.use(requireAuth,requireOrganization);

const ACCEPTED_RECEIPTS=new Set(["image/jpeg","image/png","application/pdf"]);
const MAX_RECEIPT_BYTES=5*1024*1024;
const draftSchema=z.object({
  type:z.enum(["LICENSE","EXTRA"]),
  plan:z.enum(["MONTHLY","ANNUAL"]).optional(),
  intent:z.enum(["ACTIVATE","RENEW","CHANGE_PLAN","EXTRA"]).optional(),
  selectedEndDate:z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  extraStoreCount:z.coerce.number().int().min(0).max(20).default(0),
  metadata:z.record(z.string(),z.any()).default({}),
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

async function calculateDraft(client,user,input){
  const org=(await client.query("SELECT * FROM organizations WHERE id=$1 FOR UPDATE",[user.organizationId])).rows[0];
  if(!org)throw new HttpError(404,"Tashkilot topilmadi");
  const activeStores=Number((await client.query("SELECT count(*)::int AS count FROM stores WHERE organization_id=$1 AND active=true",[user.organizationId])).rows[0]?.count||0);
  const today=organizationCalendarDateISO(org);
  const currentExpiry=org.expiry_date?String(org.expiry_date).slice(0,10):null;
  const futureExpiry=currentExpiry&&currentExpiry>today?currentExpiry:today;
  const requestedPlan=input.plan||org.plan||"ANNUAL";
  const plan=BILLING_PLANS[requestedPlan]?requestedPlan:"ANNUAL";
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
    currentEndDate=futureExpiry;
    if(!selectedEndDate||selectedEndDate<=currentEndDate)throw new HttpError(400,"Uzaytirish sanasi joriy davr tugashidan keyin bo‘lishi kerak","INVALID_RENEWAL_DATE");
    extensionDays=daysBetween(currentEndDate,selectedEndDate);
    const minimumExtras=Math.max(0,activeStores-BILLING_PLANS[renewalPlan].includedStores);
    extraStoreCount=Math.max(minimumExtras,extraStoreCount);
    baseAmount=planExtensionPrice(renewalPlan,extensionDays);
    extraStoreAmount=extraStoreExtensionPrice(renewalPlan,extensionDays,extraStoreCount);
    return {type:"LICENSE",plan:renewalPlan,intent,currentEndDate,selectedEndDate,extensionDays,baseAmount,extraStoreCount,extraStoreAmount,totalAmount:baseAmount+extraStoreAmount,activeStores};
  }else{
    currentEndDate=futureExpiry;
    selectedEndDate=addMonths(currentEndDate,selectedPlan.months);
    extensionDays=daysBetween(currentEndDate,selectedEndDate);
    const minimumExtras=Math.max(0,activeStores-selectedPlan.includedStores);
    extraStoreCount=Math.max(minimumExtras,extraStoreCount);
    baseAmount=selectedPlan.amount;
    extraStoreAmount=selectedPlan.extraStoreAmount*extraStoreCount;
  }
  return {type:input.type,plan:input.type==="EXTRA"?(BILLING_PLANS[org.plan]?org.plan:"ANNUAL"):plan,intent,currentEndDate,selectedEndDate,extensionDays,baseAmount,extraStoreCount,extraStoreAmount,totalAmount:baseAmount+extraStoreAmount,activeStores};
}

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
    const metadata={...input.metadata,intent:calculated.intent,purpose:input.metadata?.purpose||undefined,activeStores:calculated.activeStores};
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

router.post("/payments",requirePermission("billingWrite"),asyncRoute(async(req,res)=>{
  const input=z.object({draftId:z.string().uuid(),receiptId:z.string().uuid()}).parse(req.body);
  const payment=await withTransaction(async(client)=>{
    const draft=(await client.query("SELECT * FROM billing_drafts WHERE id=$1 AND organization_id=$2 AND created_by=$3 AND status='open' AND expires_at>now() FOR UPDATE",[input.draftId,req.user.organizationId,req.user.id])).rows[0];
    if(!draft)throw new HttpError(409,"To‘lov drafti topilmadi yoki muddati tugagan","BILLING_DRAFT_EXPIRED");
    const receipt=(await client.query("SELECT id,file_name,mime_type FROM billing_receipts WHERE id=$1 AND organization_id=$2",[input.receiptId,req.user.organizationId])).rows[0];
    if(!receipt)throw new HttpError(404,"To‘lov cheki topilmadi","RECEIPT_NOT_FOUND");
    const existing=await client.query("SELECT 1 FROM billing_payments WHERE organization_id=$1 AND type=$2 AND status='REVIEW' LIMIT 1",[req.user.organizationId,draft.type]);
    if(existing.rowCount)throw new HttpError(409,"Bu turdagi to‘lov allaqachon tekshiruvda","PAYMENT_ALREADY_PENDING");
    const p=(await client.query(`INSERT INTO billing_payments(organization_id,draft_id,order_id,type,plan,amount,service_period_from,service_period_to,extension_days,extra_store_count,receipt_id,receipt_name,receipt_type,submitted_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[
      req.user.organizationId,draft.id,draft.order_id,draft.type,draft.plan,draft.total_amount,draft.current_end_date,draft.selected_end_date,draft.extension_days,draft.extra_store_count,
      receipt.id,receipt.file_name,receipt.mime_type,req.user.id,
    ])).rows[0];
    await client.query("UPDATE billing_drafts SET status='submitted',updated_at=now() WHERE id=$1",[draft.id]);
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"submit",entityType:"billing_payment",entityId:p.id,title:"To‘lov tekshiruvga yuborildi",description:`${p.order_id} · ${Number(p.amount)}`});
    return p;
  });
  ok(res,{payment:publicPayment(payment)},201);
}));

export default router;
