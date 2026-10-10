import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncRoute, ok, HttpError } from '../lib/http.js';
import { requireAuth, requireOrganization, requireActiveLicense } from '../middleware/auth.js';
import { hasPermission } from '../lib/permissions.js';
import { scopedStoreId } from '../lib/storeScope.js';
import { financeReport } from '../services/financeReport.js';

const router=Router();
router.get('/',requireAuth,requireOrganization,requireActiveLicense,asyncRoute(async(req,res)=>{
  const modules=['moduleDashboard','moduleHistory','moduleAnalytics','moduleSellerAnalytics'];
  if(!modules.some(permission=>hasPermission(req.user,permission)))throw new HttpError(403,'Reports forbidden','FORBIDDEN');
  const storeId=scopedStoreId(req.user,req.query.storeId);
  const sellerId=['CASHIER','SALES'].includes(req.user.appRole)?req.user.id:(req.query.sellerId||null);
  for(const id of [storeId,sellerId,req.query.shiftId])if(id&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new HttpError(400,'Invalid report scope','INVALID_REPORT_SCOPE');
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report=await financeReport(client,{organizationId:req.user.organizationId,storeId,sellerId,from:req.query.from,to:req.query.to,limit:req.query.limit,offset:req.query.offset,search:req.query.search,paymentMethod:req.query.paymentMethod,shiftId:req.query.shiftId});
    await client.query('COMMIT');
    ok(res,report);
  } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}));
export default router;
