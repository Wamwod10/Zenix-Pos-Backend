import {createSupplierInvoice} from "../services/supplierInvoices.js";
import { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { pool } from "../db/pool.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { assertOrganizationStore, assertStoreScope, isBranchLocked, scopedStoreId } from "../lib/storeScope.js";
import { writeAudit } from "../services/audit.js";
import { enqueueNotification } from "../services/notifications.js";
import { assertShiftCashAvailable } from "../lib/shiftCash.js";
import { hasPermission } from "../lib/permissions.js";
import {sumMoney,isMoneyInput} from '../lib/posMoney.js';
import {financialWriteReplay,lockFinancialOrganization} from '../services/financialWriteReplay.js';

const router=Router();
// Never coerce nullable/blank monetary input to 0 or tolerate fractions
// smaller than a cent; PostgreSQL NUMERIC(18,2) must never round an intent.
const moneyValue=z.union([z.string(),z.number()])
  .refine(isMoneyInput,{message:'Summa aniq 2 kasr belgigacha bo‘lishi kerak'})
  .transform(Number)
  .pipe(z.number().min(0).max(999999999999.99));
router.use(requireAuth,requireOrganization);router.use(requireActiveLicense);
const supplierSchema=z.object({name:z.string().trim().min(2).max(180),phone:z.string().trim().max(40).default(""),contactName:z.string().trim().max(160).default(""),telegram:z.string().trim().max(160).default(""),metadata:z.record(z.string(),z.any()).default({})});

router.get("/",requirePermission("moduleSuppliers"),asyncRoute(async(req,res)=>{
  const branchStoreId=isBranchLocked(req.user)?scopedStoreId(req.user,null):null;
  const args=branchStoreId?[req.user.organizationId,branchStoreId]:[req.user.organizationId];
  const {rows}=await pool.query(`SELECT s.*,COALESCE((SELECT sum(greatest(i.total-i.paid_amount,0)) FROM supplier_invoices i WHERE i.supplier_id=s.id${branchStoreId?" AND i.store_id=$2":""}),0) debt FROM suppliers s WHERE s.organization_id=$1 ORDER BY s.created_at DESC`,args);
  ok(res,{suppliers:rows});
}));

router.post("/",requirePermission("supplierWrite"),asyncRoute(async(req,res)=>{
  const input=supplierSchema.parse(req.body);
  const supplier=await withTransaction(async(client)=>{
    await lockFinancialOrganization(client,req.user.organizationId);
    const row=(await client.query(`INSERT INTO suppliers(organization_id,name,phone,contact_name,telegram,metadata) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user.organizationId,input.name,input.phone,input.contactName,input.telegram,input.metadata||{}])).rows[0];
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"create",entityType:"supplier",entityId:row.id,title:"Ta’minotchi qo‘shildi",description:row.name});
    return row;
  });
  ok(res,{supplier},201);
}));

router.patch("/:id",requirePermission("supplierWrite"),asyncRoute(async(req,res)=>{
  const input=supplierSchema.partial().parse(req.body);
  const supplier=await withTransaction(async(client)=>{
    await lockFinancialOrganization(client,req.user.organizationId);
    const current=(await client.query("SELECT * FROM suppliers WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.user.organizationId])).rows[0];
    if(!current)throw new HttpError(404,"Ta’minotchi topilmadi");
    const row=(await client.query(`UPDATE suppliers SET name=$3,phone=$4,contact_name=$5,telegram=$6,metadata=$7,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`,[req.params.id,req.user.organizationId,input.name??current.name,input.phone??current.phone,input.contactName??current.contact_name,input.telegram??current.telegram,input.metadata??current.metadata??{}])).rows[0];
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"update",entityType:"supplier",entityId:row.id,title:"Ta’minotchi tahrirlandi",description:row.name,before:{name:current.name,phone:current.phone},after:{name:row.name,phone:row.phone}});
    return row;
  });
  ok(res,{supplier});
}));

router.post("/:id/archive",requirePermission("supplierWrite"),asyncRoute(async(req,res)=>{
  const supplier=await withTransaction(async(client)=>{
    await lockFinancialOrganization(client,req.user.organizationId);
    const debt=Number((await client.query("SELECT COALESCE(sum(greatest(total-paid_amount,0)),0) debt FROM supplier_invoices WHERE organization_id=$1 AND supplier_id=$2",[req.user.organizationId,req.params.id])).rows[0].debt);
    if(debt>0)throw new HttpError(409,"Qarzi mavjud ta’minotchini arxivlab bo‘lmaydi","SUPPLIER_HAS_DEBT");
    const row=(await client.query("UPDATE suppliers SET archived=true,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *",[req.params.id,req.user.organizationId])).rows[0];
    if(!row)throw new HttpError(404,"Ta’minotchi topilmadi");
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"archive",entityType:"supplier",entityId:row.id,title:"Ta’minotchi arxivlandi",description:row.name});
    return row;
  });
  ok(res,{supplier});
}));

router.post("/:id/restore",requirePermission("supplierWrite"),asyncRoute(async(req,res)=>{
  const supplier=await withTransaction(async(client)=>{
    await lockFinancialOrganization(client,req.user.organizationId);
    const row=(await client.query("UPDATE suppliers SET archived=false,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *",[req.params.id,req.user.organizationId])).rows[0];
    if(!row)throw new HttpError(404,"Ta’minotchi topilmadi");
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"restore",entityType:"supplier",entityId:row.id,title:"Ta’minotchi tiklandi",description:row.name});
    return row;
  });
  ok(res,{supplier});
}));

router.post("/:id/invoices",requirePermission("supplierWrite"),asyncRoute(async(req,res)=>{
  const input=z.object({clientReference:z.string().trim().min(1).max(120),storeId:z.string().uuid().optional().nullable(),invoiceNo:z.string().trim().max(120).default(""),total:moneyValue.refine(value=>value>0),paidAmount:moneyValue.default(0),paymentMethod:z.enum(["cash","card","transfer","purchase"]).default("purchase"),dueDate:z.string().date().optional().nullable()}).refine((v)=>v.paidAmount<=v.total,{message:"To‘langan summa jami summadan oshmasin"}).parse(req.body);
  const effectiveStoreId=scopedStoreId(req.user,input.storeId);
  if(effectiveStoreId)assertStoreScope(req.user,effectiveStoreId);
  const invoice=await withTransaction(client=>createSupplierInvoice(client,{user:req.user,supplierId:z.string().uuid().parse(req.params.id),input,storeId:effectiveStoreId}));
  ok(res,{invoice},201);
}));

router.post("/:id/payments",requirePermission("supplierWrite"),asyncRoute(async(req,res)=>{
  const input=z.object({invoiceId:z.string().uuid().optional().nullable(),storeId:z.string().uuid().optional().nullable(),shiftId:z.string().uuid().optional().nullable(),fromRegister:z.boolean().default(false),amount:moneyValue.refine(value=>value>0,'Summa musbat bo‘lsin'),method:z.enum(["cash","card","transfer"]),note:z.string().max(500).default(""),clientReference:z.string().trim().max(120).default("")}).parse(req.body);
  const effectiveStoreId=scopedStoreId(req.user,input.storeId);
  if(effectiveStoreId)assertStoreScope(req.user,effectiveStoreId);
  const payment=await withTransaction(async(client)=>financialWriteReplay(client,{organizationId:req.user.organizationId,userId:req.user.id,operation:'supplier_payment',clientReference:input.clientReference,input:{supplierId:req.params.id,...input,storeId:effectiveStoreId}},async()=>{
    const orgId=req.user.organizationId;
    if(effectiveStoreId)await assertOrganizationStore(client,orgId,effectiveStoreId);
    if(input.method==="cash"&&input.fromRegister){
      if(!effectiveStoreId||!input.shiftId)throw new HttpError(409,"Joriy kassadan to‘lov uchun filial va ochiq smena kerak","SHIFT_REQUIRED");
      const shift=(await client.query("SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open' FOR UPDATE",[input.shiftId,orgId,effectiveStoreId])).rows[0];
      if(!shift)throw new HttpError(409,"Naqd to‘lov uchun ochiq smena topilmadi","SHIFT_REQUIRED");
      if(String(shift.cashier_id)!==String(req.user.id)&&!hasPermission(req.user,"shiftRecon"))throw new HttpError(403,"Kassadan supplier to‘lovi faqat o‘z smenangizdan yoki smena nazorati ruxsati bilan bajariladi","SHIFT_FORBIDDEN");
      await assertShiftCashAvailable(client,shift,input.amount,{message:"Supplier to‘lovi uchun kassada yetarli naqd pul yo‘q"});
    }
    const supplier=(await client.query("SELECT * FROM suppliers WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,orgId])).rows[0];
    if(!supplier)throw new HttpError(404,"Ta’minotchi topilmadi");

    const params=[orgId,supplier.id];
    const filters=["organization_id=$1","supplier_id=$2","total>paid_amount"];
    if(effectiveStoreId){params.push(effectiveStoreId);filters.push(`store_id=$${params.length}`);}
    if(input.invoiceId){params.push(input.invoiceId);filters.push(`id=$${params.length}`);}
    const invoices=(await client.query(`SELECT * FROM supplier_invoices WHERE ${filters.join(" AND ")} ORDER BY due_date NULLS LAST,created_at FOR UPDATE`,params)).rows;
    if(!invoices.length)throw new HttpError(409,"Ochiq nakladnoy topilmadi","NO_OPEN_INVOICE");

    let remaining=input.amount;
    for(const invoice of invoices){
      if(remaining<=0)break;
      const balance=sumMoney([invoice.total,-Number(invoice.paid_amount)]);
      const applied=Math.min(balance,remaining);
      remaining=sumMoney([remaining,-applied]);
      await client.query("UPDATE supplier_invoices SET paid_amount=paid_amount+$2 WHERE id=$1",[invoice.id,applied]);
    }
    if(remaining>0)throw new HttpError(409,"To‘lov ochiq qarzdan oshib ketdi","PAYMENT_EXCEEDS_DEBT");

    const invoiceStoreIds=[...new Set(invoices.map((invoice)=>invoice.store_id).filter(Boolean))];
    const paymentStoreId=effectiveStoreId||(invoiceStoreIds.length===1?invoiceStoreIds[0]:null);
    const row=(await client.query(`INSERT INTO supplier_payments(organization_id,supplier_id,invoice_id,store_id,shift_id,amount,method,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[orgId,supplier.id,input.invoiceId||null,paymentStoreId,input.shiftId||null,input.amount,input.method,input.note,req.user.id])).rows[0];
    if(input.method==="cash"&&input.fromRegister)await client.query(`INSERT INTO shift_movements(organization_id,shift_id,type,amount,reason,source,reference_id,created_by) VALUES($1,$2,'out',$3,$4,'supplier',$5,$6)`,[orgId,input.shiftId,input.amount,`Ta’minotchi: ${supplier.name}`,row.id,req.user.id]);
    await writeAudit(client,{organizationId:orgId,userId:req.user.id,storeId:paymentStoreId,action:"payment",entityType:"supplier",entityId:row.id,title:"Ta’minotchiga to‘lov",description:`${supplier.name} · ${input.amount}`});
    return row;
  }));
  ok(res,{payment},201);
}));

export default router;
