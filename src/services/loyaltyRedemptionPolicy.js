import {z} from 'zod';
import {HttpError} from '../lib/http.js';
import {quoteLoyaltyRedemption} from './loyaltyRedemptionQuote.js';
export const redemptionPolicySchema=z.object({enabled:z.boolean(),valuePerPoint:z.number().int().min(1).max(1000000),maxShareBps:z.number().int().min(1).max(10000)}).strict();
export function readRedemptionPolicy(settings,currency){
 const raw=settings?.workspaceSettings?.loyalty?.redemption;
 if(raw?.enabled!==true)return {enabled:false};
 if(currency!=='UZS')throw new HttpError(409,'Bonus sarflash faqat UZS valyutasida sozlanadi','LOYALTY_CURRENCY_UNSUPPORTED');
 const parsed=redemptionPolicySchema.safeParse(raw);
 if(!parsed.success)throw new HttpError(409,'Bonus sarflash sozlamalari noto‘g‘ri','LOYALTY_POLICY_INVALID');
 return parsed.data;
}
export async function readCustomerRedemptionQuote(client,{organizationId,customerId,settings,currency,total,requestedPoints=0,lockCustomer=false}){
 const policy=readRedemptionPolicy(settings,currency);
 const customer=(await client.query('SELECT id FROM customers WHERE organization_id=$1 AND id=$2 AND archived=false'+(lockCustomer?' FOR UPDATE':''),[organizationId,customerId])).rows[0];
 if(!customer)throw new HttpError(404,'Faol mijoz topilmadi','CUSTOMER_NOT_FOUND');
 const row=(await client.query('SELECT COALESCE(sum(points),0)::text AS points FROM customer_loyalty_ledger WHERE organization_id=$1 AND customer_id=$2',[organizationId,customerId])).rows[0];
 try{return quoteLoyaltyRedemption({policy,total,balance:row?.points??'0',requestedPoints})}catch(error){if(error instanceof RangeError)throw new HttpError(409,'Bonus ballari yoki summa yetarli emas. Hisobni yangilang.','LOYALTY_QUOTE_INVALID');throw error}
}
