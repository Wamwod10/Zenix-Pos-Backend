import { HttpError } from '../lib/http.js';
import { writeAudit } from './audit.js';
import { withTransaction } from '../db/tx.js';
import { effectiveStoreLimit } from './extraStoreEntitlements.js';
import { databaseDateISO, organizationCalendarDateISO } from '../lib/businessDate.js';

// Explicit holds and expired extra-store rights are distinct mechanisms. An
// expired pass never archives a branch, modifies stock, or closes an open shift.
export function assertStoreCanTrade(organization, storeId) {
  const holds = organization?.settings?.storeTradingHolds;
  if (holds && typeof holds === 'object' && Object.hasOwn(holds, String(storeId))) {
    throw new HttpError(423, 'Ushbu filialda yangi savdolar vaqtincha cheklangan. Administrator bilan bog‘laning.', 'STORE_TRADING_HOLD');
  }
}

/**
 * The oldest active branches keep the base paid capacity. Extra branches lose
 * permission to start NEW sales/shifts as soon as purchased rights expire.
 * This is deterministic, tenant-scoped and does not delete/archive anything.
 * An owner can manage branches; an administrator may also apply explicit holds.
 */
export async function assertStoreWithinPaidCapacity(client, organization, storeId, capacity) {
  const allowed=capacity??await effectiveStoreLimit(client,organization);
  const {rows} = await client.query(`SELECT id FROM stores
    WHERE organization_id=$1 AND active=true
    ORDER BY created_at ASC,id ASC`,[organization.id]);
  const position=rows.findIndex(row=>String(row.id)===String(storeId));
  if(position<0) throw new HttpError(409,'Filial faol emas yoki topilmadi','STORE_INACTIVE');
  if(position>=allowed) throw new HttpError(402,
    'Ushbu filial uchun pullik limit tugagan. Billing orqali filial obunasini uzaytiring yoki administrator bilan bog‘laning.',
    'STORE_ENTITLEMENT_EXPIRED');
  return {allowed,position};
}

export async function lockStoreTradingAuthorization(client, input, legacyStoreId) {
  // Preserve the existing internal call signature while adopting the input contract.
  const {organizationId,storeId,now}=typeof input==='object'?input:{organizationId:input,storeId:legacyStoreId};
  // Billing review, branch lifecycle and admin holds all lock this org row.
  const org = (await client.query('SELECT id,settings,store_limit,timezone,license_status,expiry_date FROM organizations WHERE id=$1 FOR UPDATE',[organizationId])).rows[0];
  if (!org) throw new HttpError(404,'Tashkilot topilmadi','ORGANIZATION_NOT_FOUND');
  // Capture the date AFTER the lock wait and from the newly locked timezone.
  // License dates retain their inclusive local-calendar contract; extra passes
  // use [starts_on, expires_on). Business-day reporting cutoffs are separate.
  const businessDate=organizationCalendarDateISO(org,now||new Date());
  const status=String(org.license_status||'PAYMENT_REQUIRED').toUpperCase();
  if(status==='SUSPENDED')throw new HttpError(403,'Akkaunt administrator tomonidan bloklangan. Administrator bilan bog‘laning.','ACCOUNT_SUSPENDED');
  if(org.settings?.billingHold)throw new HttpError(402,'Billing cheklovini olib tashlash uchun administrator bilan bog‘laning.','BILLING_HOLD');
  if(status==='EXPIRED'||(org.expiry_date&&databaseDateISO(org.expiry_date)<businessDate))throw new HttpError(402,'Tarif muddati tugagan. Billing orqali obunani uzaytiring.','LICENSE_EXPIRED');
  if(!['ACTIVE','APPROVED'].includes(status))throw new HttpError(402,
    status==='REVIEW'?'To‘lov tekshirilmoqda. Administrator tasdig‘ini kuting.':'Zenix POS tarifini Billing orqali faollashtiring.',
    status==='REVIEW'?'LICENSE_REVIEW':'PAYMENT_REQUIRED');
  if(storeId)assertStoreCanTrade(org,storeId);
  const allowed=await effectiveStoreLimit(client,org,businessDate);
  if(storeId)await assertStoreWithinPaidCapacity(client,org,storeId,allowed);
  return {...org,businessDate,effectiveStoreLimit:allowed};
}

export async function changeStoreTradingHold(client, { organizationId, storeId, actorId, action, reason }) {
  if (!['HOLD','RELEASE'].includes(action)) throw new HttpError(400,'Noto‘g‘ri amal','INVALID_HOLD_ACTION');
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 500) {
    throw new HttpError(400,'O‘zgartirish sababini kamida 10 belgi bilan yozing','REASON_REQUIRED');
  }
  const org = (await client.query('SELECT id,settings FROM organizations WHERE id=$1 FOR UPDATE',[organizationId])).rows[0];
  if (!org) throw new HttpError(404,'Tashkilot topilmadi','ORGANIZATION_NOT_FOUND');
  const store = (await client.query('SELECT id,name,active FROM stores WHERE organization_id=$1 AND id=$2',[organizationId,storeId])).rows[0];
  if (!store) throw new HttpError(404,'Filial topilmadi','STORE_NOT_FOUND');
  const settings = {...(org.settings||{})};
  const holds = {...(settings.storeTradingHolds||{})};
  const previous = holds[storeId]||null;
  if (action === 'HOLD') {
    if (!store.active) throw new HttpError(409,'Arxivdagi filialga savdo cheklovi kerak emas','STORE_ARCHIVED');
    if (previous) throw new HttpError(409,'Filial allaqachon cheklangan','STORE_ALREADY_HELD');
    holds[storeId] = {reason:reason.trim(),at:new Date().toISOString()};
  } else {
    if (!previous) throw new HttpError(409,'Filial cheklanmagan','STORE_NOT_HELD');
    delete holds[storeId];
  }
  settings.storeTradingHolds = holds;
  await client.query('UPDATE organizations SET settings=$2::jsonb,updated_at=now() WHERE id=$1',[organizationId,JSON.stringify(settings)]);
  await writeAudit(client,{organizationId,userId:actorId,storeId,action:action==='HOLD'?'store_trading_hold':'store_trading_release',entityType:'store',entityId:storeId,
    title:action==='HOLD'?'Filial savdosi cheklangan':'Filial savdosi qayta ochildi',description:reason.trim(),before:{held:Boolean(previous)},after:{held:action==='HOLD'}});
  return {storeId,storeName:store.name,held:action==='HOLD'};
}

export function controlStoreTradingHold(input) {
  return withTransaction(client=>changeStoreTradingHold(client,input));
}
