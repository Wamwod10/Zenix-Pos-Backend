import {createHash} from 'node:crypto';
import {HttpError} from '../lib/http.js';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const requestFingerprint=input=>{const {businessDate,...financialInput}=input;return createHash('sha256').update(JSON.stringify(canonical(financialInput))).digest('hex')};
const conflict=()=>{throw new HttpError(409,'Bu identifikator boshqa amal uchun ishlatilgan','IDEMPOTENCY_CONFLICT')};
export function assertSaleReplay(row,{storeId,actorId,fingerprint}){
 if(row.store_id!==storeId||row.seller_id!==actorId||row.metadata?.requestFingerprint&&row.metadata.requestFingerprint!==fingerprint)conflict();
}
export function assertRefundReplay(row,{saleId,actorId,productId,quantity,reason,refundMethod}){
 if(row.sale_id!==saleId||row.created_by!==actorId||row.product_id!==productId||Number(row.quantity)!==quantity||row.reason!==reason||row.refund_method!==refundMethod)conflict();
}
