import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { withTransaction } from "../db/tx.js";
import { writeAudit } from "../services/audit.js";
import { normalizePromoCode } from "../services/promoCodes.js";
import { pool } from "../db/pool.js";
import { BILLING_PLANS } from "../config/billing.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { reviewBillingPayment } from "../services/billingReview.js";
import { activeExtraStoreCount, storeLimitReconciliation } from "../services/extraStoreEntitlements.js";
import { recoverySnapshot } from "../services/tenantRecovery.js";
import { controlStoreTradingHold } from "../services/storeTradingHolds.js";
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

// Read-only recovery/expiry diagnostics. These endpoints never mutate tenant data.
router.get("/organizations/:id/recovery-preview",asyncRoute(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);
  let snapshot;
  try{snapshot=await recoverySnapshot(pool,id)}catch(error){
    if(error?.message==='Organization not found in snapshot')throw new HttpError(404,'Tashkilot topilmadi','ORG_NOT_FOUND');
    throw error;
  }
  ok(res,{snapshot,restoreAvailable:false});
}));
router.get("/organizations/:id/store-reconciliation",asyncRoute(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);
  const org=(await pool.query('SELECT id,store_limit,timezone,settings FROM organizations WHERE id=$1',[id])).rows[0];
  if(!org)throw new HttpError(404,'Tashkilot topilmadi','ORG_NOT_FOUND');
  const reconciliation=await storeLimitReconciliation(pool,org);
  reconciliation.heldStoreIds=Object.keys(org.settings?.storeTradingHolds||{});
  ok(res,{reconciliation});
}));

// Explicit, reversible hold; never auto-select a store or destroy its data.
router.post('/organizations/:id/stores/:storeId/trading-hold',asyncRoute(async(req,res)=>{
  const organizationId=z.string().uuid().parse(req.params.id);
  const storeId=z.string().uuid().parse(req.params.storeId);
  const input=z.object({action:z.enum(['HOLD','RELEASE']),reason:z.string().trim().min(10).max(500)}).strict().parse(req.body);
  const result=await controlStoreTradingHold({organizationId,storeId,actorId:req.user.id,...input});
  ok(res,{result});
}));

// The platform dashboard must not download every tenant, user and payment on login.
router.get("/promos",asyncRoute(async(req,res)=>{
 const rows=(await pool.query(`SELECT p.*,
  (SELECT count(*)::int FROM platform_promo_uses u WHERE u.promo_id=p.id) AS uses
  FROM platform_promos p ORDER BY p.created_at DESC LIMIT 250`)).rows;
 ok(res,{promos:rows.map(p=>({id:p.id,code:p.code,plan:p.plan,percent:p.discount_percent,maxUses:p.max_uses,uses:Number(p.uses),perBusiness:p.max_uses_per_org,active:p.active,expiresAt:p.expires_at}))});
}));
router.post("/promos",asyncRoute(async(req,res)=>{
 const input=z.object({code:z.string().trim().regex(/^[a-z0-9-]{4,40}$/i),plan:z.enum(["MONTHLY","ANNUAL","BOTH"]),percent:z.union([z.literal(20),z.literal(50),z.literal(75),z.literal(100)]),maxUses:z.number().int().min(1).max(100000),perBusiness:z.number().int().min(1).max(100000).default(1),expiresAt:z.string().datetime().nullable().optional()}).parse(req.body);
 const code=normalizePromoCode(input.code);
 const row=(await pool.query(`INSERT INTO platform_promos(code,plan,discount_percent,max_uses,max_uses_per_org,expires_at,created_by)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,code,plan,discount_percent,max_uses,max_uses_per_org,active,expires_at`,
 [code,input.plan,input.percent,input.maxUses,input.perBusiness,input.expiresAt||null,req.user.id])).rows[0];
 ok(res,{promo:row},201);
}));
router.post("/promos/:id/deactivate",asyncRoute(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);
 const row=(await pool.query("UPDATE platform_promos SET active=false WHERE id=$1 RETURNING id,code,active",[id])).rows[0];
 if(!row)throw new HttpError(404,"Promokod topilmadi");
 ok(res,{promo:row});
}));
// Passwords are never readable. Reset creates only a bcrypt hash and invalidates all sessions.
router.post("/organizations/:orgId/users/:userId/reset-password",asyncRoute(async(req,res)=>{
 const orgId=z.string().uuid().parse(req.params.orgId),userId=z.string().uuid().parse(req.params.userId);
 const body=z.object({password:z.string().min(12).max(128),reason:z.string().trim().min(10).max(500)}).parse(req.body);
 const hash=await bcrypt.hash(body.password,12);
 await withTransaction(async(client)=>{
   await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[orgId]);
   const target=(await client.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE",[userId,orgId])).rows[0];
   if(!target)throw new HttpError(404,"Xodim topilmadi","USER_NOT_FOUND");
   const row=(await client.query("UPDATE users SET password_hash=$3,must_change_password=true,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING name",[userId,orgId,hash])).rows[0];
   if(!row)throw new HttpError(404,"Xodim topilmadi","USER_NOT_FOUND");
   await client.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[userId]);
   await writeAudit(client,{organizationId:orgId,userId:req.user.id,action:'password_reset',entityType:'user',entityId:userId,title:'Parol tiklandi',description:body.reason});
 });ok(res,{success:true});
}));
// Usage is an estimate of the rows' JSON payload + uploaded file bytes, not an exact PostgreSQL billing allocation.
router.get("/organizations/:id/usage",asyncRoute(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);
 const rows=(await pool.query(`SELECT
  (SELECT count(*)::int FROM products WHERE organization_id=$1) products,
  (SELECT count(*)::int FROM sales WHERE organization_id=$1) sales,
  (SELECT count(*)::int FROM users WHERE organization_id=$1) users,
  (SELECT count(*)::int FROM stores WHERE organization_id=$1) stores,
  (SELECT COALESCE(sum(octet_length(content)),0)::bigint FROM billing_receipts WHERE organization_id=$1) receipt_bytes,
  (SELECT COALESCE(sum(pg_column_size(row_to_json(s))),0)::bigint FROM sales s WHERE s.organization_id=$1) sales_approx_bytes`,[id])).rows[0];
 ok(res,{usage:{products:rows.products,sales:rows.sales,users:rows.users,stores:rows.stores,receiptBytes:Number(rows.receipt_bytes||0),estimatedBytes:Number(rows.receipt_bytes||0)+Number(rows.sales_approx_bytes||0),estimate:true}});
}));

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
  const [users,stores,payments,passes,activeExtraStores]=await Promise.all([
    pool.query("SELECT id,store_id,name,username,phone,app_role,active,created_at FROM users WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",[organizationId]),
    pool.query("SELECT id,name,active,created_at FROM stores WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",[organizationId]),
    pool.query(`SELECT bp.*,o.name AS organization_name,bd.metadata->>'intent' AS draft_intent
      FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id
      LEFT JOIN billing_drafts bd ON bd.id=bp.draft_id WHERE bp.organization_id=$1
      ORDER BY bp.submitted_at DESC,bp.id DESC LIMIT 20`,[organizationId]),
    pool.query(`SELECT e.id,e.quantity,e.duration,e.starts_on,e.expires_on,e.created_at,
      (e.starts_on<=(now() AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent'))::date
       AND e.expires_on>(now() AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent'))::date) AS active
      FROM extra_store_entitlements e JOIN organizations o ON o.id=e.organization_id
      WHERE e.organization_id=$1 ORDER BY e.created_at DESC LIMIT 100`,[organizationId]),
    activeExtraStoreCount(pool,rows[0]),
  ]);
  ok(res,{organization:{...organizationView({...rows[0],license_status:rows[0].effective_license_status}),
    activeExtraStores,effectiveStoreLimit:Number(rows[0].store_limit||0)+activeExtraStores,
    extraStoreEntitlements:passes.rows.map(e=>({id:e.id,quantity:Number(e.quantity),duration:e.duration,startsOn:e.starts_on,expiresOn:e.expires_on,active:Boolean(e.active)})),
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
    organizations:orgs.rows.map((row)=>({id:row.id,name:row.name,owner:row.owner_name||"",phone:row.owner_phone||row.phone||"",stores:Number(row.store_count||0),storeLimit:Number(row.store_limit||0),plan:row.plan,licenseStatus:row.license_status,expiryDate:row.expiry_date,createdAt:row.created_at,billingHold:Boolean(row.settings?.billingHold),users:usersByOrg.get(String(row.id))||[],storeRows:storesByOrg.get(String(row.id))||[]})),
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
