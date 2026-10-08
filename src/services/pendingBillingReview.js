import { HttpError } from '../lib/http.js';

// LICENSE and EXTRA quotes both change the same organization's store_limit.
// Allowing both to await approval at once can make the later license approval
// overwrite store slots that were already purchased on an EXTRA payment.
export async function assertNoConflictingBillingReview(client, organizationId, exceptPaymentId = null) {
  const { rowCount } = await client.query(`SELECT id FROM billing_payments
    WHERE organization_id=$1 AND status='REVIEW' AND ($2::uuid IS NULL OR id<>$2::uuid)
    LIMIT 1`, [organizationId, exceptPaymentId]);
  if (rowCount) {
    throw new HttpError(409,
      'Boshqa to‘lov hali tekshiruvda. Avval uni tasdiqlang yoki rad eting.',
      'BILLING_REVIEW_CONFLICT');
  }
}
