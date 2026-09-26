import { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { assertOrganizationStore, assertStoreScope } from "../lib/storeScope.js";
import { writeAudit } from "../services/audit.js";
import { enqueueNotification } from "../services/notifications.js";
import { assertShiftCashAvailable } from "../lib/shiftCash.js";
import { hasPermission } from "../lib/permissions.js";

const router=Router();
router.use(requireAuth,requireOrganization);router.use(requireActiveLicense);

const schema=z.object({
  storeId:z.string().uuid(),
  shiftId:z.string().uuid().optional().nullable(),
  title:z.string().trim().min(2).max(200),
  category:z.string().trim().max(120).default(""),
  amount:z.coerce.number().positive(),
  paymentMethod:z.enum(["cash","card","transfer"]).default("cash"),
  note:z.string().max(500).default(""),
  metadata:z.record(z.string(),z.any()).default({}),
});

async function requireCashShift(client,{organizationId,storeId,shiftId,paymentMethod}){
  if(paymentMethod!=="cash")return null;
  if(!shiftId)throw new HttpError(409,"Naqd xarajat uchun ochiq smena kerak","SHIFT_REQUIRED");
  const shift=(await client.query("SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open' FOR UPDATE",[shiftId,organizationId,storeId])).rows[0];
  if(!shift)throw new HttpError(409,"Naqd xarajat uchun ochiq smena topilmadi","SHIFT_REQUIRED");
  return shift;
}

async function assertExpenseMutable(client,expense){
  if(expense.payment_method!=="cash"||!expense.shift_id)return;
  const shift=(await client.query("SELECT id,status FROM shifts WHERE id=$1 AND organization_id=$2 FOR UPDATE",[expense.shift_id,expense.organization_id])).rows[0];
  if(shift&&shift.status!=="open")throw new HttpError(409,"Yopilgan smenaga tegishli naqd xarajatni tahrirlab yoki o‘chirib bo‘lmaydi","SHIFT_CLOSED_IMMUTABLE");
}

router.post("/",requirePermission("expensesWrite"),asyncRoute(async(req,res)=>{
  const input=schema.parse(req.body);assertStoreScope(req.user,input.storeId);
  const expense=await withTransaction(async(client)=>{
    const store=await assertOrganizationStore(client,req.user.organizationId,input.storeId);
    const cashShift=await requireCashShift(client,{organizationId:req.user.organizationId,storeId:input.storeId,shiftId:input.shiftId,paymentMethod:input.paymentMethod});
    if(cashShift){
      if(String(cashShift.cashier_id)!==String(req.user.id)&&!hasPermission(req.user,"shiftRecon"))throw new HttpError(403,"Naqd xarajat faqat o‘z smenangizdan yoki smena nazorati ruxsati bilan bajariladi","SHIFT_FORBIDDEN");
      await assertShiftCashAvailable(client,cashShift,input.amount);
    }
    const metadata={...(input.metadata||{}),employeeId:req.user.id,employee:req.user.name};
    const row=(await client.query(`INSERT INTO expenses(organization_id,store_id,shift_id,title,category,amount,payment_method,note,metadata,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[req.user.organizationId,input.storeId,input.shiftId||null,input.title,input.category,input.amount,input.paymentMethod,input.note,metadata,req.user.id])).rows[0];
    if(input.paymentMethod==="cash")await client.query(`INSERT INTO shift_movements(organization_id,shift_id,type,amount,reason,source,reference_id,created_by)
      VALUES($1,$2,'out',$3,$4,'expense',$5,$6)`,[req.user.organizationId,input.shiftId,input.amount,`Xarajat: ${input.title}`,row.id,req.user.id]);
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId:input.storeId,action:"create",entityType:"expense",entityId:row.id,title:"Xarajat qo‘shildi",description:`${input.title} · ${input.amount}`});
    await enqueueNotification(client,{organizationId:req.user.organizationId,storeId:input.storeId,eventType:"expense.created",eventId:row.id,payload:{expenseId:row.id,title:input.title,amount:Number(input.amount),category:input.category,storeName:store.name,userName:req.user.name}});
    return row;
  });
  ok(res,{expense},201);
}));

router.patch("/:id",requirePermission("expensesWrite"),asyncRoute(async(req,res)=>{
  const input=schema.partial().parse(req.body);
  const expense=await withTransaction(async(client)=>{
    const old=(await client.query("SELECT * FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.user.organizationId])).rows[0];
    if(!old)throw new HttpError(404,"Xarajat topilmadi");
    assertStoreScope(req.user,old.store_id);
    await assertExpenseMutable(client,old);
    const next={
      storeId:input.storeId??old.store_id,shiftId:input.shiftId===undefined?old.shift_id:input.shiftId,title:input.title??old.title,
      category:input.category??old.category,amount:input.amount??Number(old.amount),paymentMethod:input.paymentMethod??old.payment_method,
      note:input.note??old.note,metadata:{...(old.metadata||{}),...(input.metadata||{})},
    };
    assertStoreScope(req.user,next.storeId);await assertOrganizationStore(client,req.user.organizationId,next.storeId);
    const cashShift=await requireCashShift(client,{organizationId:req.user.organizationId,storeId:next.storeId,shiftId:next.shiftId,paymentMethod:next.paymentMethod});
    // Remove the previous ledger entry before validating the replacement so an
    // edit does not count the same expense twice against available cash.
    await client.query("DELETE FROM shift_movements WHERE organization_id=$1 AND source='expense' AND reference_id=$2",[req.user.organizationId,old.id]);
    if(cashShift){
      if(String(cashShift.cashier_id)!==String(req.user.id)&&!hasPermission(req.user,"shiftRecon"))throw new HttpError(403,"Naqd xarajat faqat o‘z smenangizdan yoki smena nazorati ruxsati bilan bajariladi","SHIFT_FORBIDDEN");
      await assertShiftCashAvailable(client,cashShift,next.amount);
    }
    const row=(await client.query(`UPDATE expenses SET store_id=$3,shift_id=$4,title=$5,category=$6,amount=$7,payment_method=$8,note=$9,metadata=$10,updated_at=now()
      WHERE id=$1 AND organization_id=$2 RETURNING *`,[old.id,req.user.organizationId,next.storeId,next.shiftId||null,next.title,next.category,next.amount,next.paymentMethod,next.note,next.metadata])).rows[0];
    if(next.paymentMethod==="cash")await client.query(`INSERT INTO shift_movements(organization_id,shift_id,type,amount,reason,source,reference_id,created_by)
      VALUES($1,$2,'out',$3,$4,'expense',$5,$6)`,[req.user.organizationId,next.shiftId,next.amount,`Xarajat: ${next.title}`,row.id,req.user.id]);
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId:next.storeId,action:"update",entityType:"expense",entityId:row.id,title:"Xarajat tahrirlandi",description:next.title,before:{title:old.title,amount:Number(old.amount),paymentMethod:old.payment_method},after:{title:next.title,amount:Number(next.amount),paymentMethod:next.paymentMethod}});
    return row;
  });
  ok(res,{expense});
}));

router.delete("/:id",requirePermission("expensesWrite"),asyncRoute(async(req,res)=>{
  await withTransaction(async(client)=>{
    const row=(await client.query("SELECT * FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE",[req.params.id,req.user.organizationId])).rows[0];
    if(!row)throw new HttpError(404,"Xarajat topilmadi");
    assertStoreScope(req.user,row.store_id);
    await assertExpenseMutable(client,row);
    await client.query("DELETE FROM shift_movements WHERE organization_id=$1 AND source='expense' AND reference_id=$2",[req.user.organizationId,row.id]);
    await client.query("DELETE FROM expenses WHERE id=$1 AND organization_id=$2",[row.id,req.user.organizationId]);
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId:row.store_id,action:"delete",entityType:"expense",entityId:row.id,title:"Xarajat o‘chirildi",description:row.title,before:{title:row.title,amount:Number(row.amount),paymentMethod:row.payment_method}});
  });
  ok(res,{deleted:true});
}));

export default router;
