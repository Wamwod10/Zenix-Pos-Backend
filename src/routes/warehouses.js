import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool.js';
import {withTransaction} from '../db/tx.js';
import {asyncRoute,HttpError,ok} from '../lib/http.js';
import {requireAuth,requireOrganization,requireActiveLicense,requirePermission} from '../middleware/auth.js';
import {assertStoreScope,assertOrganizationStore} from '../lib/storeScope.js';
import {writeAudit} from '../services/audit.js';

const router=Router();
router.use(requireAuth,requireOrganization,requireActiveLicense,requirePermission('moduleInventory'));
router.get('/',asyncRoute(async(req,res)=>{
  const {storeId}=z.object({storeId:z.string().uuid()}).strict().parse(req.query);
  assertStoreScope(req.user,storeId);
  await assertOrganizationStore(pool,req.user.organizationId,storeId,{activeOnly:false});
  const args=[req.user.organizationId,storeId];
  const [locations,stock]=await Promise.all([
    pool.query('SELECT id,store_id,name,is_default,active FROM warehouses WHERE organization_id=$1 AND store_id=$2 AND active=true ORDER BY is_default DESC,created_at,id',args),
    pool.query('SELECT b.warehouse_id,b.product_id,b.quantity FROM warehouse_balances b JOIN warehouses w ON w.id=b.warehouse_id AND w.organization_id=b.organization_id AND w.store_id=b.store_id WHERE b.organization_id=$1 AND b.store_id=$2 AND w.active=true',args),
  ]);
  ok(res,{warehouses:locations.rows,balances:stock.rows});
}));
router.post('/',requirePermission('inventoryAdjust'),asyncRoute(async(req,res)=>{
  const input=z.object({storeId:z.string().uuid(),name:z.string().trim().min(2).max(120)}).strict().parse(req.body);
  assertStoreScope(req.user,input.storeId);
  const warehouse=await withTransaction(async db=>{
    await assertOrganizationStore(db,req.user.organizationId,input.storeId);
    const row=(await db.query('INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,$3) RETURNING *',[req.user.organizationId,input.storeId,input.name])).rows[0];
    await writeAudit(db,{organizationId:req.user.organizationId,userId:req.user.id,storeId:input.storeId,action:'create',entityType:'warehouse',entityId:row.id,title:'Ombor yaratildi',description:row.name});
    return row;
  });
  ok(res,{warehouse},201);
}));
router.patch('/:id',requirePermission('inventoryAdjust'),asyncRoute(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),input=z.object({name:z.string().trim().min(2).max(120)}).strict().parse(req.body);
  const warehouse=await withTransaction(async db=>{
    const current=(await db.query('SELECT * FROM warehouses WHERE id=$1 AND organization_id=$2 AND active=true FOR UPDATE',[id,req.user.organizationId])).rows[0];
    if(!current)throw new HttpError(404,'Ombor topilmadi','WAREHOUSE_NOT_FOUND');
    assertStoreScope(req.user,current.store_id);
    const row=(await db.query('UPDATE warehouses SET name=$3,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *',[id,req.user.organizationId,input.name])).rows[0];
    await writeAudit(db,{organizationId:req.user.organizationId,userId:req.user.id,storeId:current.store_id,action:'update',entityType:'warehouse',entityId:id,title:'Ombor tahrirlandi',before:current.name,after:row.name});
    return row;
  });
  ok(res,{warehouse});
}));
export default router;
