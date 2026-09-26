import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission } from "../middleware/auth.js";
import { ORGANIZATION_CONFIGURABLE_ROLES, ROLES, isOrganizationPermissionKey } from "../lib/permissions.js";
import { writeAudit } from "../services/audit.js";
import { isBranchLocked } from "../lib/storeScope.js";

const router=Router();
router.use(requireAuth,requireOrganization);

router.get("/",asyncRoute(async(req,res)=>{
  const [orgResult,prefResult]=await Promise.all([
    pool.query(`SELECT name,phone,address,timezone,currency,settings FROM organizations WHERE id=$1`,[req.user.organizationId]),
    pool.query(`SELECT ui_preferences,selected_store_id FROM user_preferences WHERE user_id=$1`,[req.user.id]),
  ]);
  const org=orgResult.rows[0]||{};
  const settings=org.settings||{};
  ok(res,{
    organization:{businessName:org.name||"",phone:org.phone||"",address:org.address||"",timezone:org.timezone||"Asia/Tashkent",currency:org.currency||"UZS",...(settings.workspaceSettings?.organization||{})},
    workspaceSettings:settings.workspaceSettings||{},
    businessFeatures:settings.businessFeatures||{},
    rolePermissions:settings.rolePermissions||{},
    uiPreferences:prefResult.rows[0]?.ui_preferences||{},
    selectedStoreId:prefResult.rows[0]?.selected_store_id||null,
  });
}));

const workspaceSchema=z.object({
  workspaceSettings:z.record(z.string(),z.any()).optional(),
  businessFeatures:z.record(z.string(),z.any()).optional(),
  rolePermissions:z.record(z.string(),z.any()).optional(),
});
router.patch("/workspace",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const input=workspaceSchema.parse(req.body);
  if(input.rolePermissions){
    if(req.user.appRole!==ROLES.OWNER)throw new HttpError(403,"Rol ruxsatlarini faqat tashkilot egasi o‘zgartira oladi","PERMISSION_ADMIN_REQUIRED");
    const configurable=new Set(ORGANIZATION_CONFIGURABLE_ROLES);
    for(const [role,permissions] of Object.entries(input.rolePermissions||{})){
      if(!configurable.has(role))throw new HttpError(400,"Bu rol ruxsatlarini o‘zgartirib bo‘lmaydi","INVALID_ROLE_PERMISSION",role);
      const invalid=Object.keys(permissions||{}).filter((key)=>!isOrganizationPermissionKey(key));
      if(invalid.length)throw new HttpError(400,"Noma’lum yoki tizim ruxsatini berib bo‘lmaydi","INVALID_PERMISSION",invalid);
    }
  }
  const result=await withTransaction(async(client)=>{
    const current=(await client.query(`SELECT settings,name,phone,address,timezone,currency FROM organizations WHERE id=$1 FOR UPDATE`,[req.user.organizationId])).rows[0];
    const currentSettings=current?.settings||{};
    const next={...currentSettings};
    if(input.workspaceSettings)next.workspaceSettings=input.workspaceSettings;
    if(input.businessFeatures)next.businessFeatures=input.businessFeatures;
    if(input.rolePermissions)next.rolePermissions=input.rolePermissions;
    const orgSettings=next.workspaceSettings?.organization||{};
    const updated=(await client.query(`UPDATE organizations SET settings=$2::jsonb,name=COALESCE(NULLIF($3,''),name),phone=COALESCE($4,phone),address=COALESCE($5,address),timezone=COALESCE(NULLIF($6,''),timezone),currency=COALESCE(NULLIF($7,''),currency),updated_at=now() WHERE id=$1 RETURNING name,phone,address,timezone,currency`,[
      req.user.organizationId,JSON.stringify(next),String(orgSettings.businessName||""),orgSettings.phone??null,orgSettings.address??null,orgSettings.timezone||null,orgSettings.currency||null,
    ])).rows[0];
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,action:"update",entityType:"settings",entityId:req.user.organizationId,title:"Sozlamalar yangilandi",description:input.rolePermissions?"Rol ruxsatlari va ish maydoni sozlamalari yangilandi":"Ish maydoni sozlamalari yangilandi",before:{organization:{name:current?.name,phone:current?.phone,address:current?.address,timezone:current?.timezone,currency:current?.currency},settings:currentSettings},after:{organization:updated,settings:next}});
    return next;
  });
  ok(res,{success:true,settings:result});
}));

const prefSchema=z.object({uiPreferences:z.record(z.string(),z.any()).optional(),selectedStoreId:z.string().uuid().nullable().optional()});
router.patch("/preferences",asyncRoute(async(req,res)=>{
  const input=prefSchema.parse(req.body);
  if(input.selectedStoreId){
    if(isBranchLocked(req.user)&&String(input.selectedStoreId)!==String(req.user.storeId||""))throw new HttpError(403,"Bu filialni tanlashga ruxsat yo‘q","STORE_SCOPE_FORBIDDEN");
    const {rowCount}=await pool.query(`SELECT 1 FROM stores WHERE id=$1 AND organization_id=$2 AND active=true`,[input.selectedStoreId,req.user.organizationId]);
    if(!rowCount)input.selectedStoreId=null;
  }
  await pool.query(`INSERT INTO user_preferences(user_id,ui_preferences,selected_store_id) VALUES($1,$2::jsonb,$3)
    ON CONFLICT(user_id) DO UPDATE SET ui_preferences=CASE WHEN $4 THEN EXCLUDED.ui_preferences ELSE user_preferences.ui_preferences END,selected_store_id=CASE WHEN $5 THEN EXCLUDED.selected_store_id ELSE user_preferences.selected_store_id END,updated_at=now()`,[
    req.user.id,JSON.stringify(input.uiPreferences||{}),input.selectedStoreId??null,Object.prototype.hasOwnProperty.call(input,"uiPreferences"),Object.prototype.hasOwnProperty.call(input,"selectedStoreId"),
  ]);
  ok(res,{success:true});
}));

export default router;
