import { enqueueNotification } from "./notifications.js";

export const PAYMENT_REVIEW_EVENT = "billing.payment_review";

export const enqueuePaymentReviewNotification = (client, payment) => enqueueNotification(client, {
  organizationId: payment.organization_id,
  storeId: null,
  eventType: PAYMENT_REVIEW_EVENT,
  eventId: payment.id,
  payload: { paymentId: payment.id },
});
