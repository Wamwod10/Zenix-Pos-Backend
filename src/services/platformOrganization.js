import { z } from 'zod';
import { BILLING_PLANS } from '../config/billing.js';
import { databaseDateISO, organizationCalendarDateISO } from '../lib/businessDate.js';
import { HttpError } from '../lib/http.js';
import { withTransaction } from '../db/tx.js';
import { writeAudit } from './audit.js';

const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
  const date=new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
},'Sana noto‘g‘ri');

export const organizationControlSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('SUSPEND'),reason:z.string().trim().min(8).max(1000)}).strict(),
  z.object({action:z.literal('RESTORE'),reason:z.string().trim().min(8).max(1000)}).strict(),
  z.object({action:z.literal('SET_LICENSE'),reason:z.string().trim().min(8).max(1000),plan:z.enum(Object.keys(BILLING_PLANS)),expiryDate:dateSchema,storeLimit:z.number().int().min(1).max(500)}).strict(),
]);

// Never write to a tenant without explicitly locking its organization row. All
// administrative overrides are in the same transaction as their audit log.
export async function applyOrganizationControl(client,{organizationId,actorId,input}){
    const org=(await client.query('SELECT id,name,plan,license_status,expiry_date,store_limit,timezone FROM organizations WHERE id=$1 FOR UPDATE',[organizationId])).rows[0];
    if(!org)throw new HttpError(404,'Tashkilot topilmadi','ORG_NOT_FOUND');
    const previous={plan:org.plan,licenseStatus:org.license_status,expiryDate:databaseDateISO(org.expiry_date),storeLimit:Number(org.store_limit)};
    const today=organizationCalendarDateISO(org);
    let target;
    if(input.action==='SUSPEND'){
      if(org.license_status==='SUSPENDED')throw new HttpError(409,'Tashkilot allaqachon bloklangan','ALREADY_SUSPENDED');
      target={...previous,licenseStatus:'SUSPENDED'};
    }else if(input.action==='RESTORE'){
      if(org.license_status!=='SUSPENDED')throw new HttpError(409,'Tashkilot bloklanmagan','NOT_SUSPENDED');
      target={...previous,licenseStatus:previous.expiryDate&&previous.expiryDate>=today?'ACTIVE':'EXPIRED'};
    }else{
      if(input.expiryDate<today)throw new HttpError(400,'Tarif muddati o‘tgan sana bo‘lishi mumkin emas','INVALID_LICENSE_EXPIRY');
      const count=Number((await client.query('SELECT count(*)::int AS count FROM stores WHERE organization_id=$1 AND active=true',[organizationId])).rows[0]?.count||0);
      if(input.storeLimit<count)throw new HttpError(409,`Hozir ${count} ta faol filial bor. Limitni bundan kamaytirib bo‘lmaydi`,'STORE_LIMIT_BELOW_USAGE');
      // Explicit super-admin correction: never approve a pending payment as a side effect.
      target={plan:input.plan,licenseStatus:org.license_status==='SUSPENDED'?'SUSPENDED':'ACTIVE',expiryDate:input.expiryDate,storeLimit:input.storeLimit};
    }
    if(input.action==='SET_LICENSE'){
      const pending=(await client.query("SELECT 1 FROM billing_payments WHERE organization_id=$1 AND status='REVIEW' LIMIT 1",[organizationId])).rowCount;
      if(pending)throw new HttpError(409,'Tekshiruvdagi to‘lov tugamaguncha tarifni qo‘lda o‘zgartirib bo‘lmaydi','PENDING_BILLING_REVIEW');
    }
    await client.query('UPDATE organizations SET plan=$2,license_status=$3,expiry_date=$4,store_limit=$5,updated_at=now() WHERE id=$1',[organizationId,target.plan,target.licenseStatus,target.expiryDate,target.storeLimit]);
    await writeAudit(client,{organizationId,userId:actorId,action:'platform_override',entityType:'organization',entityId:organizationId,title:'Platform administratori tashkilotni boshqardi',description:input.reason,before:previous,after:target,metadata:{action:input.action}});
    return {id:organizationId,name:org.name,plan:target.plan,licenseStatus:target.licenseStatus,expiryDate:target.expiryDate,storeLimit:target.storeLimit};
}

export const controlOrganization = input => withTransaction(client=>applyOrganizationControl(client,input));
