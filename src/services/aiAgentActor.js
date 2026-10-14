import {HttpError} from '../lib/http.js';
import {hasPermission} from '../lib/permissions.js';
import {authorizationKey} from './aiPolicy.js';
import {subscriptionPlan} from '../config/subscriptions.js';

export function assertAgentEnabled(settings,{write=false}={}){
 if(settings?.enabled!==true)throw new HttpError(503,'AI hozir mavjud emas','AI_UNAVAILABLE');
 if(write&&settings?.writesEnabled!==true)throw new HttpError(403,'AI orqali kirim o‘chirilgan','AI_WRITES_DISABLED');
}
export function assertAgentPermission(user,...permissions){
 if(!user||user.appRole==='PLATFORM_ADMIN'||permissions.some(p=>!hasPermission(user,p)))throw new HttpError(403,'Bu amal uchun ruxsat yo‘q','AI_FORBIDDEN');
}
// Lock in quota order (organization first), and keep authorization stable until commit.
export async function recheckAgentActor(db,user,key=authorizationKey(user)){
 const org=(await db.query(`SELECT o.*,subscription_effective_plan(id) code,subscription_can_write(id) writable FROM organizations o WHERE id=$1 FOR UPDATE`,[user.organizationId])).rows[0];
 const row=(await db.query(`SELECT u.app_role,u.store_id,u.permission_overrides,u.active,u.must_change_password
 FROM users u JOIN auth_sessions s ON s.user_id=u.id
 WHERE u.id=$1 AND u.organization_id=$2 AND s.id=$3 AND s.revoked_at IS NULL AND s.expires_at>now() FOR SHARE OF u,s`,[user.id,user.organizationId,user.sessionId])).rows[0];
 const current=row&&{...user,appRole:row.app_role,storeId:row.store_id,permissionOverrides:row.permission_overrides||{},rolePermissions:org?.settings?.rolePermissions||{}};
 if(!org||!row||!row.active||row.must_change_password||!org.writable||authorizationKey(current)!==key)throw new HttpError(403,'Sessiya yoki ruxsatlar o‘zgargan','AI_ACCESS_CHANGED');
 const plan=org.plan_code?subscriptionPlan(org.code,org.pricing_version||1):null;
 if(!plan?.limits.aiRequests)throw new HttpError(403,'Business yoki Premium tarifi kerak','AI_PLAN_REQUIRED');
 return current;
}
export async function requireAgentReservation(db,user,requestId,key,{completed=false,actionId}={}){
 const row=(await db.query(`SELECT * FROM ai_requests WHERE organization_id=$1 AND user_id=$2 AND request_id=$3 FOR SHARE`,[user.organizationId,user.id,requestId])).rows[0];
 const linked=!actionId||row?.response?.action?.id===actionId||row?.response?.actions?.some(a=>a.id===actionId);
 if(!row||row.authorization_key!==key||(completed?(row.status!=='SUCCEEDED'||!row.response||new Date(row.response_expires_at)<=new Date()||!linked):(!['PENDING','DISPATCHED'].includes(row.status)||new Date(row.lease_ends_at)<=new Date())))throw new HttpError(409,'AI so‘rovi tasdiqlanmagan yoki muddati tugagan','AI_REQUEST_REQUIRED');
 return row;
}
