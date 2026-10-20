import { enqueueNotification } from "./notifications.js";

export const PAYMENT_REVIEW_EVENT = "billing.payment_review";

export function paymentReviewSnapshot(payment) {
  const fields=['id','organization_name','owner_name','owner_phone','type','plan','draft_metadata','store_limit','extra_store_count','extension_days','amount','order_id','submitted_at'];
  return Object.fromEntries(fields.map(key=>[key,payment[key]]));
}

export async function enqueuePaymentReviewUpdate(client,payment,actor, {chatId,messageId,hasCaption} = {}) {
  if (!chatId || !messageId || !['APPROVED','REJECTED'].includes(payment.status)) return false;
  const snapshot={...paymentReviewSnapshot(payment),status:payment.status,reviewed_at:payment.reviewed_at,reject_reason:payment.reject_reason};
  await enqueueNotification(client,{organizationId:payment.organization_id,eventType:'billing.payment_review_updated',eventId:payment.id,
    payload:{payment:snapshot,actor,chatId:String(chatId),messageId:String(messageId),hasCaption:Boolean(hasCaption)}});
  return true;
}

export const enqueuePaymentReviewNotification = (client, payment) => enqueueNotification(client, {
  organizationId: payment.organization_id,
  storeId: null,
  eventType: PAYMENT_REVIEW_EVENT,
  eventId: payment.id,
  payload: { paymentId: payment.id },
});
