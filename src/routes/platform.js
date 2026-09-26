import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { BILLING_PLANS } from "../config/billing.js";
import { organizationCalendarDateISO } from "../lib/businessDate.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";

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
  const [orgs,payments]=await Promise.all([
    pool.query(`SELECT o.*,owner.name AS owner_name,owner.phone AS owner_phone,
      (SELECT count(*)::int FROM stores st WHERE st.organization_id=o.id AND st.active=true) AS store_count
      FROM organizations o LEFT JOIN LATERAL (SELECT u.name,u.phone FROM users u WHERE u.organization_id=o.id AND u.app_role='OWNER' ORDER BY u.created_at LIMIT 1) owner ON true
      ORDER BY o.created_at DESC`),
    pool.query(`SELECT bp.*,o.name AS organization_name FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id ORDER BY bp.submitted_at DESC LIMIT 5000`),
  ]);
  ok(res,{
    organizations:orgs.rows.map((row)=>({id:row.id,name:row.name,owner:row.owner_name||"",phone:row.owner_phone||row.phone||"",stores:Number(row.store_count||0),plan:row.plan,licenseStatus:row.license_status,expiryDate:row.expiry_date,storeLimit:Number(row.store_limit||0),createdAt:row.created_at})),
    payments:payments.rows.map(paymentView),
  });
}));

router.get("/receipts/:id",asyncRoute(async(req,res)=>{
  const row=(await pool.query("SELECT file_name,mime_type,content FROM billing_receipts WHERE id=$1",[req.params.id])).rows[0];
  if(!row)throw new HttpError(404,"Chek topilmadi");
  res.setHeader("Content-Type",row.mime_type);res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`);res.setHeader("Cache-Control","private, max-age=60");res.send(row.content);
}));

router.post("/payments/:id/review",asyncRoute(async(req,res)=>{
  const input=z.object({status:z.enum(["APPROVED","REJECTED"]),reason:z.string().trim().max(1000).default("")}).parse(req.body);
  if(input.status==="REJECTED"&&!input.reason)throw new HttpError(400,"Rad etish sababini kiriting","REJECT_REASON_REQUIRED");
  const payment=await withTransaction(async(client)=>{
    const row=(await client.query("SELECT bp.*,o.license_status,o.expiry_date,o.store_limit,o.timezone FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id WHERE bp.id=$1 FOR UPDATE OF bp,o",[req.params.id])).rows[0];
    if(!row)throw new HttpError(404,"To‘lov topilmadi");
    if(row.status!=="REVIEW")throw new HttpError(409,"Bu to‘lov allaqachon ko‘rib chiqilgan","PAYMENT_ALREADY_REVIEWED");
    const reviewed=(await client.query("UPDATE billing_payments SET status=$2,reject_reason=$3,reviewed_at=now() WHERE id=$1 RETURNING *",[row.id,input.status,input.status==="REJECTED"?input.reason:""])).rows[0];
    if(input.status==="APPROVED"){
      if(row.type==="EXTRA"){
        await client.query("UPDATE organizations SET store_limit=store_limit+$2,updated_at=now() WHERE id=$1",[row.organization_id,Math.max(1,Number(row.extra_store_count||1))]);
      }else{
        const plan=BILLING_PLANS[row.plan]?row.plan:"ANNUAL";
        const included=BILLING_PLANS[plan].includedStores;
        const extras=Math.max(0,Number(row.extra_store_count||0));
        await client.query("UPDATE organizations SET plan=$2,license_status='ACTIVE',expiry_date=$3,store_limit=$4,updated_at=now() WHERE id=$1",[row.organization_id,plan,row.service_period_to,included+extras]);
      }
    }else{
      const currentExpiry=row.expiry_date?String(row.expiry_date).slice(0,10):null;
      const today=organizationCalendarDateISO({timezone:row.timezone});
      const nextStatus=currentExpiry&&currentExpiry>=today?"ACTIVE":"REJECTED";
      await client.query("UPDATE organizations SET license_status=$2,updated_at=now() WHERE id=$1",[row.organization_id,nextStatus]);
    }
    await writeAudit(client,{organizationId:row.organization_id,userId:req.user.id,action:input.status==="APPROVED"?"approve":"reject",entityType:"billing_payment",entityId:row.id,title:input.status==="APPROVED"?"To‘lov tasdiqlandi":"To‘lov rad etildi",description:`${row.order_id}${input.reason?` · ${input.reason}`:""}`});
    const orgName=(await client.query("SELECT name FROM organizations WHERE id=$1",[row.organization_id])).rows[0]?.name||"";
    return {...reviewed,organization_name:orgName};
  });
  ok(res,{payment:paymentView(payment)});
}));

export default router;
