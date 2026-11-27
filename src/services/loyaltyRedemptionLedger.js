// Intended for callers already holding the organization lock in the sale transaction.
// Not connected to production checkout: tender accounting and returns still require integration.
import {HttpError} from '../lib/http.js';
import {readCustomerRedemptionQuote} from './loyaltyRedemptionPolicy.js';
const marker='ZENIX_REDEEM_V1';
export async function debitSaleRedemption(client,{organizationId,saleId,actorId,customerId,settings,currency,requestedPoints,expectedAmount}){
 if(!Number.isSafeInteger(requestedPoints)||requestedPoints<=0||requestedPoints>999999999999)throw new HttpError(400,'Bonus ballari noto‘g‘ri','LOYALTY_POINTS_INVALID');
 const sale=(await client.query('SELECT id,customer_id,total FROM sales WHERE organization_id=$1 AND id=$2 AND customer_id=$3 FOR UPDATE',[organizationId,saleId,customerId])).rows[0];
 if(!sale)throw new HttpError(404,'Mijoz savdosi topilmadi','SALE_NOT_FOUND');
 const old=(await client.query("SELECT points FROM customer_loyalty_ledger WHERE organization_id=$1 AND customer_id=$2 AND sale_id=$3 AND entry_type='REDEEM' AND note=$4",[organizationId,customerId,saleId,marker])).rows;
 // Checkout's existing idempotency replay must return the original sale before
 // invoking the debit. Refuse a repeated debit instead of recalculating a rate.
 if(old.length)throw new HttpError(409,'Bonus avval yechilgan','LOYALTY_ALREADY_REDEEMED');
 const quote=await readCustomerRedemptionQuote(client,{organizationId,customerId,settings,currency,total:sale.total,requestedPoints,lockCustomer:true});
 if(!quote.enabled||quote.points!==requestedPoints||quote.amount!==expectedAmount)throw new HttpError(409,'Bonus hisobi o‘zgardi','LOYALTY_QUOTE_CHANGED');
 const row=(await client.query("INSERT INTO customer_loyalty_ledger(organization_id,customer_id,sale_id,entry_type,points,note,created_by) VALUES($1,$2,$3,'REDEEM',$4,$5,$6) RETURNING id",[organizationId,customerId,saleId,-requestedPoints,marker,actorId])).rows[0];
 return {...quote,ledgerId:row.id};
}
