import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission } from "../middleware/auth.js";
import { ROLES, isOrganizationPermissionKey } from "../lib/permissions.js";
import { writeAudit } from "../services/audit.js";

const router=Router();
const staffRoles=[ROLES.ADMIN,ROLES.MANAGER,ROLES.CASHIER,ROLES.SALES,ROLES.WAREHOUSE];
const roleSchema=z.enum(staffRoles);
const branchRoles=new Set([ROLES.CASHIER,ROLES.SALES,ROLES.WAREHOUSE]);
const assertPermissionOverrides=(actor,input)=>{
  if(!Object.prototype.hasOwnProperty.call(input,"permissionOverrides"))return;
  if(actor.appRole!==ROLES.OWNER)throw new HttpError(403,"Shaxsiy ruxsatlarni faqat tashkilot egasi o‘zgartira oladi","PERMISSION_ADMIN_REQUIRED");
  const invalid=Object.keys(input.permissionOverrides||{}).filter((key)=>!isOrganizationPermissionKey(key));
  if(invalid.length)throw new HttpError(400,"Noma’lum yoki tizim ruxsatini berib bo‘lmaydi","INVALID_PERMISSION",invalid);
};

const assertRoleAdministration=(actor,input,target=null)=>{
  if(actor.appRole===ROLES.OWNER)return;
  if(input.appRole===ROLES.ADMIN)throw new HttpError(403,"ADMIN rolini faqat tashkilot egasi bera oladi","ROLE_ADMIN_REQUIRED");
  if(target?.app_role===ROLES.ADMIN)throw new HttpError(403,"ADMIN hisobini faqat tashkilot egasi boshqara oladi","ROLE_ADMIN_REQUIRED");
  if(target&&String(target.id)===String(actor.id)&&input.appRole&&input.appRole!==target.app_role)throw new HttpError(403,"O‘z rolingizni o‘zgartira olmaysiz","SELF_ROLE_CHANGE_FORBIDDEN");
};
const createSchema=z.object({
  name:z.string().trim().min(2).max(160),
  username:z.string().trim().min(3).max(120),
  phone:z.string().trim().min(5).max(40),
  password:z.string().min(8).max(300),
  appRole:roleSchema,
  storeId:z.string().uuid().nullable().optional(),
  permissionOverrides:z.record(z.string(),z.boolean()).optional(),
}).refine((value)=>!branchRoles.has(value.appRole)||Boolean(value.storeId),{message:"Bu rol uchun filial tanlang",path:["storeId"]});
const updateSchema=z.object({
  name:z.string().trim().min(2).max(160).optional(),
  username:z.string().trim().min(3).max(120).optional(),
  phone:z.string().trim().min(5).max(40).optional(),
  appRole:roleSchema.optional(),
  storeId:z.string().uuid().nullable().optional(),
  active:z.boolean().optional(),
  permissionOverrides:z.record(z.string(),z.boolean()).optional(),
}).refine((value)=>Object.keys(value).length>0,{message:"Yangilash uchun ma’lumot yuboring"});
const passwordSchema=z.object({password:z.string().min(8).max(300)});
const profileSchema=z.object({name:z.string().trim().min(2).max(160),phone:z.string().trim().min(5).max(40)});
const changePasswordSchema=z.object({currentPassword:z.string().min(1).max(300),newPassword:z.string().min(8).max(300)});

const publicUser=(row)=>({
  id:row.id,
  accountId:row.id,
  organizationId:row.organization_id,
  storeId:row.store_id,
  name:row.name,
  username:row.username,
  login:row.username,
  phone:row.phone,
  appRole:row.app_role,
  role:row.app_role,
  permissionOverrides:row.permission_overrides||{},
  active:row.active!==false,
  forcePasswordChange:Boolean(row.must_change_password),
  createdAt:row.created_at,
  updatedAt:row.updated_at,
});

async function assertStore(client,organizationId,storeId){
  if(!storeId)return;
  const {rowCount}=await client.query(`SELECT 1 FROM stores WHERE id=$1 AND organization_id=$2 AND active=true`,[storeId,organizationId]);
  if(!rowCount)throw new HttpError(400,"Faol filial topilmadi","INVALID_STORE");
}

router.use(requireAuth,requireOrganization);

router.get("/",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const {rows}=await pool.query(`SELECT * FROM users WHERE organization_id=$1 ORDER BY CASE app_role WHEN 'OWNER' THEN 0 ELSE 1 END, active DESC, name`,[req.user.organizationId]);
  ok(res,{users:rows.map(publicUser)});
}));

router.get("/username-availability",asyncRoute(async(req,res)=>{
  const username=String(req.query.username||"").trim().toLowerCase();
  if(username.length<3)return ok(res,{available:false});
  const {rowCount}=await pool.query(`SELECT 1 FROM users WHERE lower(username)=lower($1) LIMIT 1`,[username]);
  ok(res,{available:rowCount===0});
}));

router.post("/",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const input=createSchema.parse(req.body);
  assertPermissionOverrides(req.user,input);
  assertRoleAdministration(req.user,input);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await assertStore(client,req.user.organizationId,input.storeId||null);
    const passwordHash=await bcrypt.hash(input.password,12);
    const {rows}=await client.query(`
      INSERT INTO users(organization_id,store_id,name,username,phone,password_hash,app_role,permission_overrides,must_change_password)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,true)
      RETURNING *`,[
      req.user.organizationId,input.storeId||null,input.name,input.username.toLowerCase(),input.phone,passwordHash,input.appRole,JSON.stringify(input.permissionOverrides||{}),
    ]);
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId:input.storeId||null,action:"create",entityType:"user",entityId:rows[0].id,title:"Xodim hisobi yaratildi",description:`${rows[0].name} · ${rows[0].app_role}`,after:{name:rows[0].name,username:rows[0].username,phone:rows[0].phone,appRole:rows[0].app_role,storeId:rows[0].store_id,active:rows[0].active}});
    await client.query("COMMIT");
    ok(res,{user:publicUser(rows[0])},201);
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}));

router.patch("/:id",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const input=updateSchema.parse(req.body);
  assertPermissionOverrides(req.user,input);
  if(req.params.id===req.user.id&&input.active===false)throw new HttpError(400,"Joriy hisobni o‘chirib bo‘lmaydi","SELF_DEACTIVATE");
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const existing=(await client.query(`SELECT * FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.params.id,req.user.organizationId])).rows[0];
    if(!existing)throw new HttpError(404,"Xodim topilmadi","USER_NOT_FOUND");
    assertRoleAdministration(req.user,input,existing);
    if(existing.app_role===ROLES.OWNER&&(input.active===false||input.appRole&&input.appRole!==ROLES.OWNER))throw new HttpError(400,"Asosiy egasining roli yoki faol holatini o‘zgartirib bo‘lmaydi","OWNER_PROTECTED");
    if(input.appRole===ROLES.OWNER&&existing.app_role!==ROLES.OWNER)throw new HttpError(400,"Egasi rolini oddiy rol o‘zgarishi orqali berib bo‘lmaydi","OWNER_PROTECTED");
    if(Object.prototype.hasOwnProperty.call(input,"storeId"))await assertStore(client,req.user.organizationId,input.storeId||null);
    const next={
      name:input.name??existing.name,
      username:(input.username??existing.username).toLowerCase(),
      phone:input.phone??existing.phone,
      appRole:input.appRole??existing.app_role,
      storeId:Object.prototype.hasOwnProperty.call(input,"storeId")?input.storeId:existing.store_id,
      active:input.active??existing.active,
      permissionOverrides:input.permissionOverrides??existing.permission_overrides,
    };
    if(branchRoles.has(next.appRole)&&!next.storeId)throw new HttpError(400,"Bu rol uchun faol filial tanlang","STORE_REQUIRED");
    const {rows}=await client.query(`UPDATE users SET name=$3,username=$4,phone=$5,app_role=$6,store_id=$7,active=$8,permission_overrides=$9::jsonb,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`,[
      existing.id,req.user.organizationId,next.name,next.username,next.phone,next.appRole,next.storeId,next.active,JSON.stringify(next.permissionOverrides||{}),
    ]);
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId:rows[0].store_id||null,action:"update",entityType:"user",entityId:rows[0].id,title:"Xodim hisobi yangilandi",description:rows[0].name,before:{name:existing.name,username:existing.username,phone:existing.phone,appRole:existing.app_role,storeId:existing.store_id,active:existing.active,permissionOverrides:existing.permission_overrides||{}},after:{name:rows[0].name,username:rows[0].username,phone:rows[0].phone,appRole:rows[0].app_role,storeId:rows[0].store_id,active:rows[0].active,permissionOverrides:rows[0].permission_overrides||{}}});
    if(input.active===false)await client.query(`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`,[existing.id]);
    await client.query("COMMIT");
    ok(res,{user:publicUser(rows[0])});
  }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
}));

router.post("/:id/reset-password",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const input=passwordSchema.parse(req.body);
  const passwordHash=await bcrypt.hash(input.password,12);
  await withTransaction(async(client)=>{
    const target=(await client.query(`SELECT * FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.params.id,req.user.organizationId])).rows[0];
    if(!target)throw new HttpError(404,"Xodim topilmadi","USER_NOT_FOUND");
    if(target.app_role===ROLES.OWNER&&req.params.id!==req.user.id)throw new HttpError(403,"Egasi parolini bu yerdan almashtirib bo‘lmaydi","OWNER_PROTECTED");
    if(req.user.appRole!==ROLES.OWNER&&target.app_role===ROLES.ADMIN)throw new HttpError(403,"ADMIN parolini faqat tashkilot egasi tiklay oladi","ROLE_ADMIN_REQUIRED");
    await client.query(`UPDATE users SET password_hash=$3,must_change_password=true,updated_at=now() WHERE id=$1 AND organization_id=$2`,[req.params.id,req.user.organizationId,passwordHash]);
    await client.query(`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`,[req.params.id,req.user.sessionId]);
  });
  ok(res,{success:true});
}));

router.patch("/me/profile",asyncRoute(async(req,res)=>{
  const input=profileSchema.parse(req.body);
  const {rows}=await pool.query(`UPDATE users SET name=$3,phone=$4,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *`,[req.user.id,req.user.organizationId,input.name,input.phone]);
  ok(res,{user:publicUser(rows[0])});
}));

router.post("/me/password",asyncRoute(async(req,res)=>{
  const input=changePasswordSchema.parse(req.body);
  const passwordHash=await bcrypt.hash(input.newPassword,12);
  await withTransaction(async(client)=>{
    const target=(await client.query(`SELECT * FROM users WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[req.user.id,req.user.organizationId])).rows[0];
    if(!target||!(await bcrypt.compare(input.currentPassword,target.password_hash)))throw new HttpError(400,"Joriy parol noto‘g‘ri","INVALID_PASSWORD");
    await client.query(`UPDATE users SET password_hash=$3,must_change_password=false,updated_at=now() WHERE id=$1 AND organization_id=$2`,[req.user.id,req.user.organizationId,passwordHash]);
    await client.query(`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`,[req.user.id,req.user.sessionId]);
  });
  ok(res,{success:true});
}));

router.get("/me/sessions",asyncRoute(async(req,res)=>{
  const {rows}=await pool.query(`SELECT id,user_agent,created_at,last_seen_at,expires_at FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC`,[req.user.id]);
  ok(res,{sessions:rows.map((row)=>({id:row.id,device:row.user_agent||"Brauzer",createdAt:row.created_at,lastSeenAt:row.last_seen_at,expiresAt:row.expires_at,current:row.id===req.user.sessionId}))});
}));

router.delete("/me/sessions/others",asyncRoute(async(req,res)=>{
  await pool.query(`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL`,[req.user.id,req.user.sessionId]);
  ok(res,{success:true});
}));

router.delete("/me/sessions/:sessionId",asyncRoute(async(req,res)=>{
  const {rowCount}=await pool.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,[req.params.sessionId,req.user.id]);
  if(!rowCount)throw new HttpError(404,"Sessiya topilmadi","SESSION_NOT_FOUND");
  ok(res,{success:true,current:req.params.sessionId===req.user.sessionId});
}));

export default router;
