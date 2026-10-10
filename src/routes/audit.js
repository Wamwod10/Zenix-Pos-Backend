import {Router} from 'express';import {z} from 'zod';import {pool} from '../db/pool.js';import {asyncRoute,ok} from '../lib/http.js';import {requireAuth,requireOrganization,requireActiveLicense,requirePermission} from '../middleware/auth.js';import {scopedStoreId,assertOrganizationStore} from '../lib/storeScope.js';import {likeTerm} from '../services/platformDirectory.js';
const router=Router();router.use(requireAuth,requireOrganization,requireActiveLicense,requirePermission('moduleActivityLog'));
const date=z.iso.date().optional();
router.get('/',asyncRoute(async(req,res)=>{
 const input=z.object({q:z.string().max(100).default(''),type:z.string().max(40).default('all'),storeId:z.string().uuid().optional(),from:date,to:date,limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).parse(req.query);
 const store=scopedStoreId(req.user,input.storeId);if(store)await assertOrganizationStore(pool,req.user.organizationId,store,{activeOnly:false});
 const params=[req.user.organizationId,store,input.type,likeTerm(input.q),input.from||null,input.to||null,input.limit+1,input.offset,req.user.organizationTimezone||'Asia/Tashkent'];
 const {rows}=await pool.query(`SELECT a.*,u.name user_name,u.app_role user_role,s.name store_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN stores s ON s.id=a.store_id
 WHERE a.organization_id=$1 AND ($2::uuid IS NULL OR a.store_id=$2)
 AND ($3='all' OR CASE WHEN a.action='return' THEN 'return' ELSE a.entity_type END=$3)
 AND (a.title ILIKE $4 ESCAPE E'\\\\' OR a.description ILIKE $4 ESCAPE E'\\\\' OR u.name ILIKE $4 ESCAPE E'\\\\')
 AND ($5::date IS NULL OR a.created_at>=($5::date::timestamp AT TIME ZONE $9)) AND ($6::date IS NULL OR a.created_at<(($6::date+1)::timestamp AT TIME ZONE $9)) ORDER BY a.created_at DESC,a.id DESC LIMIT $7 OFFSET $8`,params);
 ok(res,{items:rows.slice(0,input.limit).map(a=>({id:a.id,type:a.action==='return'?'return':a.entity_type,title:a.title,description:a.description,createdAt:a.created_at,userName:a.user_name,userRole:a.user_role,storeId:a.store_id,storeName:a.store_name,before:a.before_data,after:a.after_data,metadata:a.metadata||{}})),hasMore:rows.length>input.limit});
}));export default router;
