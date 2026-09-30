import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { BILLING_PLANS } from "../config/billing.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { reviewBillingPayment } from "../services/billingReview.js";

const router=Router();
router.use(requireAuth,requirePermission("platformAdmin"));
const n=(value)=>Number(value||0);
const paymentView=(row)=>({
  id:row.id,orderId:row.order_id,organizationId:row.organization_id,organization:row.organization_name||"",draftId:row.draft_id,
  type:row.type,plan:row.plan,amount:n(row.amount),status:row.status,servicePeriodFrom:row.service_period_from,servicePeriodTo:row.service_period_to,
  targetExpiry:row.service_period_to,extensionDays:Number(row.extension_days||0),extraStores:Number(row.extra_store_count||0),renewalExtraStores:Number(row.extra_store_count||0),
  purpose:row.type==="EXTRA"?`Qo‘shimcha filial limiti · ${Number(row.extra_store_count||0)} ta`:`${BILLING_PLANS[row.plan]?.label||row.plan} tarif`,
  receiptId:row.receipt_id,receiptName:row.receipt_name,receiptType:row.receipt_type,rejectReason:row.reject_reason||"",submittedAt:row.submitted_at,reviewedAt:row.reviewed_at,
});

router.get("/bootstrap",asyncRoute(async(_req,res)=>{
  const [orgs,payments,users,stores]=await Promise.all([
    pool.query(`SELECT o.*,owner.name AS owner_name,owner.phone AS owner_phone,
      (SELECT count(*)::int FROM stores st WHERE st.organization_id=o.id AND st.active=true) AS store_count
      FROM organizations o LEFT JOIN LATERAL (SELECT u.name,u.phone FROM users u WHERE u.organization_id=o.id AND u.app_role='OWNER' ORDER BY u.created_at LIMIT 1) owner ON true
      ORDER BY o.created_at DESC`),
    pool.query(`SELECT bp.*,o.name AS organization_name FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id ORDER BY bp.submitted_at DESC`),
    pool.query(`SELECT id,organization_id,store_id,name,username,phone,app_role,active,created_at FROM users WHERE organization_id IS NOT NULL ORDER BY created_at DESC`),
    pool.query(`SELECT id,organization_id,name,active,created_at FROM stores ORDER BY created_at DESC`),
  ]);
  const usersByOrg=new Map();for(const row of users.rows){const key=String(row.organization_id);const list=usersByOrg.get(key)||[];list.push({id:row.id,storeId:row.store_id,name:row.name,username:row.username,phone:row.phone,role:row.app_role,active:row.active,createdAt:row.created_at});usersByOrg.set(key,list)}
  const storesByOrg=new Map();for(const row of stores.rows){const key=String(row.organization_id);const list=storesByOrg.get(key)||[];list.push({id:row.id,name:row.name,active:row.active,createdAt:row.created_at});storesByOrg.set(key,list)}
  ok(res,{
    organizations:orgs.rows.map((row)=>({id:row.id,name:row.name,owner:row.owner_name||"",phone:row.owner_phone||row.phone||"",stores:Number(row.store_count||0),storeLimit:Number(row.store_limit||0),plan:row.plan,licenseStatus:row.license_status,expiryDate:row.expiry_date,createdAt:row.created_at,users:usersByOrg.get(String(row.id))||[],storeRows:storesByOrg.get(String(row.id))||[]})),
    payments:payments.rows.map(paymentView),
  });
}));

router.get("/audit-logs",asyncRoute(async(req,res)=>{
  const input=z.object({organizationId:z.string().uuid(),limit:z.coerce.number().int().min(1).max(200).default(50),offset:z.coerce.number().int().min(0).default(0)}).parse(req.query);
  const {rows}=await pool.query(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.title,a.description,a.created_at,u.name AS user_name,st.name AS store_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN stores st ON st.id=a.store_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,[input.organizationId,input.limit,input.offset]);
  ok(res,{logs:rows.map(row=>({id:row.id,action:row.action,entityType:row.entity_type,entityId:row.entity_id,title:row.title,description:row.description,createdAt:row.created_at,userName:row.user_name||"",storeName:row.store_name||""}))});
}));

router.get("/receipts/:id",asyncRoute(async(req,res)=>{
  const row=(await pool.query("SELECT file_name,mime_type,content FROM billing_receipts WHERE id=$1",[req.params.id])).rows[0];
  if(!row)throw new HttpError(404,"Chek topilmadi");
  res.setHeader("Content-Type",row.mime_type);res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);res.setHeader("Cache-Control","private, max-age=60");res.send(row.content);
}));

router.post("/payments/:id/review",asyncRoute(async(req,res)=>{
  const input=z.object({status:z.enum(["APPROVED","REJECTED"]),reason:z.string().trim().max(1000).default("")}).parse(req.body);
  if(input.status==="REJECTED"&&!input.reason)throw new HttpError(400,"Rad etish sababini kiriting","REJECT_REASON_REQUIRED");
  const result=await reviewBillingPayment({paymentId:req.params.id,decision:input.status,reason:input.reason,actor:{source:"platform",internalUserId:req.user.id}});
  if(result.outcome==="alreadyReviewed")throw new HttpError(409,"Bu to‘lov allaqachon ko‘rib chiqilgan","PAYMENT_ALREADY_REVIEWED");
  ok(res,{payment:paymentView(result.payment)});
}));

export default router;
