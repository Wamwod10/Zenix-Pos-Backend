import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { withTransaction } from "../db/tx.js";
import { writeAudit } from "../services/audit.js";
import { normalizePromoCode } from "../services/promoCodes.js";
import {issuePasswordReset} from '../services/passwordReset.js';
import { pool } from "../db/pool.js";
import { BILLING_PLANS } from "../config/billing.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { reviewBillingPayment } from "../services/billingReview.js";
import { activeExtraStoreCount, storeLimitReconciliation } from "../services/extraStoreEntitlements.js";
import { recoverySnapshot } from "../services/tenantRecovery.js";
import { backupHistory } from "../services/backupProvider.js";
import { controlStoreTradingHold } from "../services/storeTradingHolds.js";
import { controlOrganization, organizationControlSchema } from "../services/platformOrganization.js";
import { organizationPageSchema, paymentPageSchema, organizationPageSql, paymentPageSql, fetchDirectoryPage, effectiveLicenseStatusSql, likeTerm } from "../services/platformDirectory.js";

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
  await writeAudit(pool,{organizationId:id,userId:req.user.id,action:'recovery_diagnostics',entityType:'organization',entityId:id,title:'Recovery diagnostikasi ochildi'});
  const backups=await backupHistory(id);
  ok(res,{snapshot,backups,restoreAvailable:false,backupsAvailable:backups.available,reason:backups.reason});
  // No restore is offered without a tested backup provider and rollback plan.
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
 const input=z.object({q:z.string().trim().max(100).default(''),limit:z.coerce.number().int().min(1).max(100).default(20),offset:z.coerce.number().int().min(0).default(0)}).parse(req.query);
 const rows=(await pool.query(`SELECT p.*,
  (SELECT count(*)::int FROM platform_promo_uses u WHERE u.promo_id=p.id) AS uses,
  (SELECT count(*)::int FROM platform_promo_reservations r WHERE r.promo_id=p.id AND r.status='RESERVED') AS reserved
  FROM platform_promos p WHERE code ILIKE $1 ESCAPE '\\' ORDER BY p.created_at DESC,p.id DESC LIMIT $2 OFFSET $3`,[likeTerm(input.q),input.limit,input.offset])).rows;
 const total=Number((await pool.query("SELECT count(*)::int AS n FROM platform_promos WHERE code ILIKE $1 ESCAPE '\\'",[likeTerm(input.q)])).rows[0].n);
 ok(res,{total,promos:rows.map(p=>({id:p.id,code:p.code,plan:p.plan,percent:p.discount_percent,maxUses:p.max_uses,uses:Number(p.uses),reserved:Number(p.reserved),remaining:Math.max(0,p.max_uses-Number(p.uses)-Number(p.reserved)),perBusiness:p.max_uses_per_org,active:p.active,startsAt:p.starts_at,expiresAt:p.expires_at}))});
}));
router.post("/promos",asyncRoute(async(req,res)=>{
 const input=z.object({code:z.string().trim().regex(/^[a-z0-9-]{4,40}$/i),plan:z.enum(["MONTHLY","ANNUAL","BOTH"]),percent:z.union([z.literal(20),z.literal(50),z.literal(75),z.literal(100)]),maxUses:z.number().int().min(1).max(100000),perBusiness:z.number().int().min(1).max(100000).default(1),startsAt:z.string().datetime().nullable().optional(),expiresAt:z.string().datetime().nullable().optional(),active:z.boolean().default(true)}).refine(v=>!v.startsAt||!v.expiresAt||Date.parse(v.startsAt)<Date.parse(v.expiresAt),'Tugash sanasi boshlanishdan keyin bo‘lsin').parse(req.body);
 const code=normalizePromoCode(input.code);
 const row=await withTransaction(async client=>{
 const row=(await client.query(`INSERT INTO platform_promos(code,plan,discount_percent,max_uses,max_uses_per_org,expires_at,created_by,starts_at,active)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,code,plan,discount_percent,max_uses,max_uses_per_org,active,starts_at,expires_at`,
 [code,input.plan,input.percent,input.maxUses,input.perBusiness,input.expiresAt||null,req.user.id,input.startsAt||null,input.active])).rows[0];
 await writeAudit(client,{organizationId:null,userId:req.user.id,action:'promo_create',entityType:'platform_promo',entityId:row.id,title:'Promokod yaratildi',after:input});
 return row;
 });
 ok(res,{promo:row},201);
}));
router.post("/promos/:id/deactivate",asyncRoute(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);
 const row=await withTransaction(async client=>{
 const row=(await client.query("UPDATE platform_promos SET active=false WHERE id=$1 RETURNING id,code,active",[id])).rows[0];
 if(!row)throw new HttpError(404,"Promokod topilmadi");
 await writeAudit(client,{organizationId:null,userId:req.user.id,action:'promo_deactivate',entityType:'platform_promo',entityId:id,title:'Promokod to‘xtatildi'});
 return row;
 });
 ok(res,{promo:row});
}));
// Passwords are never readable. Reset creates only a bcrypt hash and invalidates all sessions.
router.post('/organizations/:orgId/users/:userId/reset-token',asyncRoute(async(req,res)=>{
 const organizationId=z.string().uuid().parse(req.params.orgId),userId=z.string().uuid().parse(req.params.userId);
 const body=z.object({reason:z.string().trim().min(10).max(500),identityVerified:z.literal(true)}).strict().parse(req.body);
 const reset=await withTransaction(client=>issuePasswordReset(client,{organizationId,userId,actorId:req.user.id,...body}));
 ok(res,{reset},201);
}));
router.post("/organizations/:orgId/users/:userId/reset-password",asyncRoute(async(req,res)=>{
 const orgId=z.string().uuid().parse(req.params.orgId),userId=z.string().uuid().parse(req.params.userId);
 const body=z.object({password:z.string().min(12).max(128),reason:z.string().trim().min(10).max(500),identityVerified:z.literal(true)}).strict().parse(req.body);
 const hash=await bcrypt.hash(body.password,12);
 await withTransaction(async(client)=>{
   await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[orgId]);
   const target=(await client.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE",[userId,orgId])).rows[0];
   if(!target)throw new HttpError(404,"Xodim topilmadi","USER_NOT_FOUND");
   const recent=Number((await client.query("SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1 AND entity_id=$2 AND action='password_reset' AND created_at>now()-interval '15 minutes'",[orgId,userId])).rows[0]?.n||0);
   if(recent>=3)throw new HttpError(429,'Tiklash limiti tugadi','RESET_RATE_LIMITED');
   const row=(await client.query("UPDATE users SET password_hash=$3,must_change_password=true,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING name",[userId,orgId,hash])).rows[0];
   if(!row)throw new HttpError(404,"Xodim topilmadi","USER_NOT_FOUND");
   await client.query("UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[userId]);
   await client.query('UPDATE password_reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[userId]);
   await writeAudit(client,{organizationId:orgId,userId:req.user.id,action:'password_reset',entityType:'user',entityId:userId,title:'Parol tiklandi',description:body.reason});
 });ok(res,{success:true});
}));
// Exact stored binary payload, separated from estimated database row storage.
router.get("/organizations/:id/usage",asyncRoute(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);
 const rows=(await pool.query(`SELECT
  (SELECT count(*)::int FROM products WHERE organization_id=$1) products,
  (SELECT count(*)::int FROM sales WHERE organization_id=$1) sales,
  (SELECT count(*)::int FROM users WHERE organization_id=$1) users,
  (SELECT count(*)::int FROM stores WHERE organization_id=$1) stores,
  (SELECT COALESCE(sum(octet_length(content)),0)::bigint FROM billing_receipts WHERE organization_id=$1) receipt_bytes,
  (SELECT COALESCE(sum(octet_length(content)),0)::bigint FROM file_assets WHERE organization_id=$1) asset_bytes,
  (SELECT COALESCE(sum(pg_column_size(row_to_json(s))),0)::bigint FROM sales s WHERE s.organization_id=$1) sales_approx_bytes`,[id])).rows[0];
 ok(res,{usage:{products:rows.products,sales:rows.sales,users:rows.users,stores:rows.stores,receiptBytes:Number(rows.receipt_bytes||0),fileBytes:Number(rows.receipt_bytes||0)+Number(rows.asset_bytes||0),fileScope:'Database-managed uploads only; external files are not measured',estimatedDatabaseBytes:Number(rows.sales_approx_bytes||0),estimate:true}});
}));

router.get("/overview",asyncRoute(async(_req,res)=>{
  const effectiveStatus=effectiveLicenseStatusSql();
  const [organizations,stores,payments]=await Promise.all([
    pool.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE (${effectiveStatus}) IN ('ACTIVE','APPROVED') AND COALESCE(o.settings->>'billingHold','false')<>'true')::int AS active,
      count(*) FILTER (WHERE o.license_status='SUSPENDED')::int AS suspended,
      count(*) FILTER (WHERE o.settings->>'billingHold'='true')::int AS payment_blocked,
      count(*) FILTER (WHERE (${effectiveStatus})='EXPIRED')::int AS expired,
      count(*) FILTER (WHERE (${effectiveStatus}) IN ('ACTIVE','APPROVED') AND NULLIF(o.settings->>'trialEndsAt','') IS NOT NULL AND (o.settings->>'trialEndsAt')::timestamptz>now())::int AS trial,
      count(*) FILTER (WHERE o.plan='MONTHLY')::int AS monthly,
      count(*) FILTER (WHERE o.plan='ANNUAL')::int AS annual FROM organizations o`),
    pool.query("SELECT count(*)::int AS total FROM stores"),
    pool.query("SELECT count(*) FILTER (WHERE status='REVIEW')::int AS review,COALESCE(sum(amount) FILTER (WHERE status='APPROVED'),0) AS revenue,count(*) FILTER (WHERE status='APPROVED' AND type='LICENSE')::int AS subscriptions FROM billing_payments"),
  ]);
  const row=organizations.rows[0];
  ok(res,{overview:{organizations:Number(row.total),active:Number(row.active),trial:Number(row.trial),suspended:Number(row.suspended),paymentBlocked:Number(row.payment_blocked),expired:Number(row.expired),plans:{MONTHLY:Number(row.monthly),ANNUAL:Number(row.annual)},revenue:Number(payments.rows[0].revenue),subscriptions:Number(payments.rows[0].subscriptions),stores:Number(stores.rows[0].total),review:Number(payments.rows[0].review)}});
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
  const metrics=(await pool.query(`SELECT
    (SELECT count(*)::int FROM products WHERE organization_id=$1) AS products,
    (SELECT count(*)::int FROM sales WHERE organization_id=$1) AS sales,
    (SELECT count(*)::int FROM customers WHERE organization_id=$1) AS customers,
    (SELECT max(s.last_seen_at) FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE u.organization_id=$1) AS last_activity,
    (SELECT COALESCE(sum(GREATEST(balance,0)),0) FROM (SELECT sum(amount) AS balance FROM customer_ledger WHERE organization_id=$1 GROUP BY customer_id) balances) AS customer_debt,
    (SELECT min(service_period_from) FROM billing_payments WHERE organization_id=$1 AND type='LICENSE' AND status='APPROVED') AS subscription_started_at`,[organizationId])).rows[0];
  ok(res,{organization:{...organizationView({...rows[0],license_status:rows[0].effective_license_status}),
    metrics:{products:Number(metrics.products),sales:Number(metrics.sales),customers:Number(metrics.customers),customerDebt:Number(metrics.customer_debt)},lastActivityAt:metrics.last_activity,subscriptionStartedAt:metrics.subscription_started_at,
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
  const input=z.object({organizationId:z.string().uuid().optional(),q:z.string().trim().max(100).default(''),limit:z.coerce.number().int().min(1).max(200).default(50),offset:z.coerce.number().int().min(0).default(0)}).parse(req.query);
  const params=[input.organizationId||null,input.limit+1,input.offset,likeTerm(input.q)];
  const {rows}=await pool.query(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.title,a.description,a.created_at,u.name AS user_name,st.name AS store_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN stores st ON st.id=a.store_id WHERE ($1::uuid IS NULL OR a.organization_id=$1) AND (a.title ILIKE $4 ESCAPE '\\' OR a.action ILIKE $4 ESCAPE '\\' OR a.description ILIKE $4 ESCAPE '\\') ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`,params);
  ok(res,{hasMore:rows.length>input.limit,logs:rows.slice(0,input.limit).map(row=>({id:row.id,action:row.action,entityType:row.entity_type,entityId:row.entity_id,title:row.title,description:row.description,createdAt:row.created_at,userName:row.user_name||"",storeName:row.store_name||""}))});
}));
router.get('/organizations/:id/support',asyncRoute(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);
 const org=(await pool.query('SELECT id,license_status,settings FROM organizations WHERE id=$1',[id])).rows[0];
 if(!org)throw new HttpError(404,'Tashkilot topilmadi','ORG_NOT_FOUND');
 const input=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),offset:z.coerce.number().int().min(0).default(0)}).parse(req.query);
 const [billing,delivery,errors]=await Promise.all([
   pool.query("SELECT id,order_id,status,reject_reason,submitted_at FROM billing_payments WHERE organization_id=$1 AND status IN ('REVIEW','REJECTED') ORDER BY submitted_at DESC,id DESC LIMIT $2 OFFSET $3",[id,input.limit+1,input.offset]),
   pool.query("SELECT id,status,attempts,created_at FROM notification_outbox WHERE organization_id=$1 AND (status='failed' OR attempts>0) ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",[id,input.limit+1,input.offset]),
   pool.query("SELECT id,title,metadata,created_at FROM audit_logs WHERE organization_id=$1 AND action IN ('api_error','api_slow') ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",[id,input.limit+1,input.offset]),
 ]);
 await writeAudit(pool,{organizationId:id,userId:req.user.id,action:'support_diagnostics',entityType:'organization',entityId:id,title:'Support diagnostikasi ochildi'});
 ok(res,{support:{licenseStatus:org.license_status,billingHold:Boolean(org.settings?.billingHold),limit:input.limit,offset:input.offset,hasMore:{billing:billing.rows.length>input.limit,delivery:delivery.rows.length>input.limit,api:errors.rows.length>input.limit},billingIssues:billing.rows.slice(0,input.limit),deliveryIssues:delivery.rows.slice(0,input.limit),apiIssues:errors.rows.slice(0,input.limit),apiDiagnosticsAvailable:true,apiDiagnosticsReason:'Authenticated API xatolari va sekin so‘rovlar tarixi; maxfiy payload saqlanmaydi'}});
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
