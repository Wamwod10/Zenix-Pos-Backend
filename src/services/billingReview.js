import { BILLING_PLANS } from "../config/billing.js";
import { withTransaction } from "../db/tx.js";
import { organizationCalendarDateISO } from "../lib/businessDate.js";
import { HttpError } from "../lib/http.js";
import { writeAudit } from "./audit.js";

export async function applyBillingReview(client, { paymentId, decision, reason = "", actor = {} }) {
  if (!new Set(["APPROVED", "REJECTED"]).has(decision)) throw new HttpError(400, "Noto'g'ri to'lov holati", "INVALID_PAYMENT_DECISION");
  const row = (await client.query(`SELECT bp.*,o.name AS organization_name,o.license_status,o.expiry_date,o.store_limit,o.timezone
    FROM billing_payments bp JOIN organizations o ON o.id=bp.organization_id
    WHERE bp.id=$1 FOR UPDATE OF bp,o`, [paymentId])).rows[0];
  if (!row) throw new HttpError(404, "To'lov topilmadi", "PAYMENT_NOT_FOUND");
  if (row.status !== "REVIEW") return { outcome: "alreadyReviewed", payment: row, organization: null };

  const reviewed = (await client.query(`UPDATE billing_payments SET status=$2,reject_reason=$3,reviewed_at=now()
    WHERE id=$1 AND status='REVIEW' RETURNING *`, [row.id, decision, decision === "REJECTED" ? reason : ""])).rows[0];
  if (!reviewed) return { outcome: "alreadyReviewed", payment: row, organization: null };

  if (decision === "APPROVED") {
    if (row.type === "EXTRA") {
      await client.query("UPDATE organizations SET store_limit=store_limit+$2,updated_at=now() WHERE id=$1", [row.organization_id, Math.max(1, Number(row.extra_store_count || 1))]);
    } else {
      const plan = BILLING_PLANS[row.plan] ? row.plan : "ANNUAL";
      const storeLimit = BILLING_PLANS[plan].includedStores + Math.max(0, Number(row.extra_store_count || 0));
      await client.query("UPDATE organizations SET plan=$2,license_status='ACTIVE',expiry_date=$3,store_limit=$4,updated_at=now() WHERE id=$1", [row.organization_id, plan, row.service_period_to, storeLimit]);
    }
  } else {
    const currentExpiry = row.expiry_date ? String(row.expiry_date).slice(0, 10) : null;
    const today = organizationCalendarDateISO({ timezone: row.timezone });
    await client.query("UPDATE organizations SET license_status=$2,updated_at=now() WHERE id=$1", [row.organization_id, currentExpiry && currentExpiry >= today ? "ACTIVE" : "REJECTED"]);
  }

  const metadata = {
    payment_id: String(row.id), organization_id: String(row.organization_id), old_status: "REVIEW", new_status: decision,
    source: String(actor.source || "platform"), telegram_admin_user_id: String(actor.telegramUserId || ""),
    telegram_admin_username: String(actor.telegramUsername || ""), telegram_chat_id: String(actor.telegramChatId || ""),
  };
  await writeAudit(client, {
    organizationId: row.organization_id, userId: actor.internalUserId || null,
    action: decision === "APPROVED" ? "approve" : "reject", entityType: "billing_payment", entityId: row.id,
    title: decision === "APPROVED" ? "To'lov tasdiqlandi" : "To'lov rad etildi",
    description: `${row.order_id}${reason ? ` - ${reason}` : ""}`, metadata,
  });
  return { outcome: decision === "APPROVED" ? "approved" : "rejected", payment: { ...reviewed, organization_name: row.organization_name }, organization: { id: row.organization_id, name: row.organization_name } };
}

export const reviewBillingPayment = (input) => withTransaction((client) => applyBillingReview(client, input));
