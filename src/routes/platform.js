import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { BILLING_PLANS } from "../config/billing.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { reviewBillingPayment } from "../services/billingReview.js";
import { controlOrganization, organizationControlSchema } from "../services/platformOrganization.js";
import { organizationPageSchema, paymentPageSchema, organizationPageSql, paymentPageSql, fetchDirectoryPage, effectiveLicenseStatusSql } from "../services/platformDirectory.js";

const router=Router();
router.use(requireAuth,requirePermission("platformAdmin"));
const n=(value)=>Number(value||0);
const paymentView=(row)=>({
  id:row.id,orderId:row.order_id,organizationId:row.organization_id,organization:row.organization_name||"",draftId:row.draft_id,
  type:row.type,plan:row.plan,intent:row.draft_intent||(row.type==="EXTRA"?"EXTRA":"RENEW"),amount:n(row.amount),status:row.status,servicePeriodFrom:row.service_period_from,servicePeriodTo:row.service_period_to,
  targetExpiry:row.service_period_to,extensionDays:Number(row.extension_days||0),extraStores:Number(row.extra_store_count||0),renewalExtraStores:Number(row.extra_store_count||0),
  purpose:row.type==="EXTRA"?`Qo‘shimcha filial limiti · ${Number(row.extra_store_count||0)} ta`:`${BILLING_PLANS[row.plan]?.label||row.plan} tarif`,
  receiptId:row.receipt_id,receiptName:row.receipt_name,receiptType:row.receipt_type,rejectReason:row.reject_reason||"",submittedAt:row.submitted_at,reviewedAt:row.reviewed_at,
});

const organizationView=(row)=>({id:row.id,name:row.name,owner:row.owner_name||"",phone:row.owner_phone||row.phone||"",stores:Number(row.store_count||0),storeLimit:Number(row.store_limit||0),plan:row.plan,licenseStatus:row.license_status,expiryDate:row.expiry_date,createdAt:row.created_at,billingHold:Boolean(row.settings?.billingHold),trialEndsAt:row.settings?.trialEndsAt||null});

// The platform dashboard must not download every tenant, user and payment on login.
router.get("/overview",asyncRoute(async(_req,res)=>{
  const effectiveStatus=effectiveLicenseStatusSql();
  const [organizations,stores,payments]=await Promise.all([
    pool.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE (${effectiveStatus}) IN ('ACTIVE','APPROVED'))::int AS active FROM organizations o`),
    pool.query("SELECT count(*)::int AS total FROM stores"),
    pool.query("SELECT count(*)::int AS review FROM billing_payments WHERE status='REVIEW'"),
  ]);
  ok(res,{overview:{organizations:Number(organizations.rows[0].total),active:Number(organizations.rows[0].active),stores:Number(stores.rows[0].total),review:Number(payments.rows[0].review)}});
}));

router.get("/organizations/page",asyncRoute(async(req,res)=>{
  const input=organizationPageSchema.parse(req.query);
  const {rows,total}=await fetchDirectoryPage(pool,organizationPageSql(input));
  ok(res,{items:rows.map(organizationView),total,limit:input.limit,offset:input.offset});
}));

router.get("/payments/page",asyncRoute(async(req,res)=>{
  const input=paymentPageSchema.parse(req.query);
  const {rows,total}=await fetchDirectoryPage(pool,paymentPageSql(input));
  ok(res,{items:rows.map(paymentView),total,limit:input.limit,offset:input.offset});
}));

router.get("/organizations/:id/detail",asyncRoute(async(req,res)=>{
  const organizationId=z.string().uuid().parse(req.params.id);
  const {rows}=await pool.query(`SELECT o.*,${effectiveLicenseStatusSql()} AS effective_license_status,owner.name AS owner_name,owner.phone AS owner_phone,
    (SELECT count(*)::int FROM stores st WHERE st.organization_id=o.id AND st.active=true) AS store_count
    FROM organizations o LEFT JOIN LATERAL (
      SELECT u.name,u.phone FROM users u WHERE u.organization_id=o.id AND u.app_role='OWNER'
      ORDER BY u.created_at ASC,u.id ASC LIMIT 1
    ) owner ON true WHERE o.id=$1`,[organizationId]);
  if(!rows.length)throw new HttpError(404,"Tashkilot topilmadi","ORG_NOT_FOUND");
  const [users,stores,payments]=await Promise.all([
    pool.query("SELECT id,store_id,name,username,phone,app_role,active,created_at FROM users WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",[organizationId]),
    pool.query("SELECT id,name,active,created_at FROM stores WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",[organizationId]),
    pool.query(`SELECT bp.*,o.name AS organization_name,bd.metadata->>'intent' AS draft_intent
      FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id
      LEFT JOIN billing_drafts bd ON bd.id=bp.draft_id WHERE bp.organization_id=$1
      ORDER BY bp.submitted_at DESC,bp.id DESC LIMIT 20`,[organizationId]),
  ]);
  ok(res,{organization:{...organizationView({...rows[0],license_status:rows[0].effective_license_status}),
    users:users.rows.map(u=>({id:u.id,storeId:u.store_id,name:u.name,username:u.username,phone:u.phone,role:u.app_role,active:u.active,createdAt:u.created_at})),
    storeRows:stores.rows.map(st=>({id:st.id,name:st.name,active:st.active,createdAt:st.created_at})),
  },payments:payments.rows.map(paymentView)});
}));

router.get("/bootstrap",asyncRoute(async(_req,res)=>{
  const [orgs,payments,users,stores]=await Promise.all([
    pool.query(`SELECT o.*,owner.name AS owner_name,owner.phone AS owner_phone,
      (SELECT count(*)::int FROM stores st WHERE st.organization_id=o.id AND st.active=true) AS store_count
      FROM organizations o LEFT JOIN LATERAL (SELECT u.name,u.phone FROM users u WHERE u.organization_id=o.id AND u.app_role='OWNER' ORDER BY u.created_at LIMIT 1) owner ON true
      ORDER BY o.created_at DESC`),
    pool.query(`SELECT bp.*,o.name AS organization_name,bd.metadata->>'intent' AS draft_intent
      FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id
      LEFT JOIN billing_drafts bd ON bd.id=bp.draft_id
      ORDER BY bp.submitted_at DESC`),
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

router.post("/organizations/:id/control",asyncRoute(async(req,res)=>{
  const organizationId=z.string().uuid().parse(req.params.id);
  const input=organizationControlSchema.parse(req.body);
  const organization=await controlOrganization({organizationId,actorId:req.user.id,input});
  ok(res,{organization});
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
