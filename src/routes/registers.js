import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool.js';
import {withTransaction} from '../db/tx.js';
import {asyncRoute,HttpError,ok} from '../lib/http.js';
import {requireAuth,requireOrganization,requirePermission} from '../middleware/auth.js';
import {assertStoreScope,assertOrganizationStore,scopedStoreId} from '../lib/storeScope.js';
import {createRegister} from '../services/posRegisters.js';
import {writeAudit} from '../services/audit.js';
const router=Router();
router.use(requireAuth,requireOrganization);
router.get('/',requirePermission('moduleShifts'),asyncRoute(async(req,res)=>{
  const requested=z.string().uuid().optional().parse(req.query.storeId);
  const storeId=scopedStoreId(req.user,requested);
  if(storeId)await assertOrganizationStore(pool,req.user.organizationId,storeId,{activeOnly:false});
  const rows=(await pool.query('SELECT * FROM pos_registers WHERE organization_id=$1 AND ($2::uuid IS NULL OR store_id=$2) ORDER BY created_at,id',[req.user.organizationId,storeId])).rows;
  ok(res,{registers:rows});
}));
router.post('/',requirePermission('settingsWrite'),asyncRoute(async(req,res)=>{
  const input=z.object({storeId:z.string().uuid(),name:z.string().trim().min(2).max(120),active:z.boolean().default(true)}).parse(req.body);
  assertStoreScope(req.user,input.storeId);
  const register=await withTransaction(async client=>{
    const row=await createRegister(client,{organizationId:req.user.organizationId,...input});
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId:input.storeId,action:'create',entityType:'pos_register',entityId:row.id,title:'POS kassa yaratildi',after:row});
    return row;
  });ok(res,{register},201);
}));
router.patch('/:id',requirePermission('settingsWrite'),asyncRoute(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);
  const input=z.object({name:z.string().trim().min(2).max(120).optional(),active:z.boolean().optional()}).parse(req.body);
  const register=await withTransaction(async client=>{
    await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[req.user.organizationId]);
    const current=(await client.query('SELECT * FROM pos_registers WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,req.user.organizationId])).rows[0];
    if(!current)throw new HttpError(404,'POS kassa topilmadi','REGISTER_NOT_FOUND');
    assertStoreScope(req.user,current.store_id);
    if(input.active===true)await assertOrganizationStore(client,req.user.organizationId,current.store_id);
    const row=(await client.query('UPDATE pos_registers SET name=COALESCE($3,name),active=COALESCE($4,active),updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',[id,req.user.organizationId,input.name??null,input.active??null])).rows[0];
    await writeAudit(client,{organizationId:req.user.organizationId,userId:req.user.id,storeId:row.store_id,action:'update',entityType:'pos_register',entityId:row.id,title:'POS kassa yangilandi',before:current,after:row});return row;
  });ok(res,{register});
}));
export default router;
