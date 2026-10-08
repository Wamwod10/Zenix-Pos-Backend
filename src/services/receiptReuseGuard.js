import { HttpError } from '../lib/http.js';

// Call only inside the submission transaction, after locking the organization
// and the selected receipt row. Different drafts must never purchase more than
// one subscription with the same uploaded receipt record OR exactly the same
// evidence uploaded again under a different receipt id. Exact byte comparison
// also protects historical receipts without requiring a destructive backfill.
// Re-encoded/cropped images can still depict the same payment: human review
// against the bank/payment provider is always mandatory.
export async function assertReceiptAvailable(client, { organizationId, receiptId }) {
  const { rows } = await client.query(
    `SELECT payment.id, payment.status FROM billing_payments payment
     JOIN billing_receipts prior_receipt
       ON prior_receipt.id=payment.receipt_id AND prior_receipt.organization_id=$1
     JOIN billing_receipts proposed_receipt
       ON proposed_receipt.id=$2 AND proposed_receipt.organization_id=$1
     WHERE payment.organization_id=$1
       AND (payment.receipt_id=$2 OR prior_receipt.content=proposed_receipt.content)
     ORDER BY payment.submitted_at DESC LIMIT 1`,
    [organizationId, receiptId],
  );
  if (rows.length) {
    throw new HttpError(409,
      'Bu chek avval boshqa to‘lovda ishlatilgan. Yangi chek yuklang.',
      'BILLING_RECEIPT_ALREADY_USED');
  }
}
