import { HttpError } from "../lib/http.js";
import { databaseDateISO } from "../lib/businessDate.js";
export const normalizePromoCode = value => String(value||"").trim().toUpperCase();
export function discountForAmount(amount,percentage){return Math.round(Number(amount||0)*Number(percentage||0)/100)}
export async function lockValidPromo(client,{code,plan,organizationId,lock=true}){
 const normalized=normalizePromoCode(code);
 const promo=(await client.query(`SELECT * FROM platform_promos WHERE code=$1${lock?' FOR UPDATE':''}`,[normalized])).rows[0];
 if(!promo||!promo.active||(promo.expires_at&&new Date(promo.expires_at).getTime()<=Date.now()))throw new HttpError(409,"Promokod mavjud emas yoki muddati tugagan","PROMO_INACTIVE");
 if(promo.starts_at&&Date.parse(promo.starts_at)>Date.now())throw new HttpError(409,'Promokod hali boshlanmagan','PROMO_NOT_STARTED');
 if(promo.plan!=="BOTH"&&promo.plan!==plan)throw new HttpError(409,"Bu promokod tanlangan tarifga tegishli emas","PROMO_PLAN_MISMATCH");
 const reserved=Number((await client.query("SELECT count(*)::int n FROM platform_promo_reservations WHERE promo_id=$1 AND status='RESERVED'",[promo.id])).rows[0]?.n||0);
 if(Number(promo.used_count)+reserved>=Number(promo.max_uses))throw new HttpError(409,"Promokod limiti tugagan. Boshqa promokod tanlang.","PROMO_EXHAUSTED");
 const used=Number((await client.query(`SELECT count(*)::int n FROM (
   SELECT id FROM platform_promo_uses WHERE promo_id=$1 AND organization_id=$2
   UNION ALL SELECT id FROM platform_promo_reservations WHERE promo_id=$1 AND organization_id=$2 AND status='RESERVED'
 ) capacity`,[promo.id,organizationId])).rows[0]?.n||0);
 if(used>=Number(promo.max_uses_per_org))throw new HttpError(409,"Bu biznes promokoddan foydalanish limitiga yetdi","PROMO_ORG_LIMIT");
 return promo;
}
export async function consumePromo(client,{promo,organizationId,plan,discountAmount,paymentId=null}){
 // Called after locking the organization and promo in that order, within the same transaction.
 const inserted=await client.query(`INSERT INTO platform_promo_uses(promo_id,organization_id,payment_id,plan,discount_amount) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(payment_id) DO NOTHING RETURNING id`,[promo.id,organizationId,paymentId,plan,discountAmount]);
 if(inserted.rowCount)await client.query("UPDATE platform_promos SET used_count=used_count+1 WHERE id=$1",[promo.id]);
}

const staleQuote = () => new HttpError(409, "Promokod hisobi mos emas. Yangi to'lov hisobini yarating.", "PROMO_QUOTE_STALE");

// PostgreSQL dates can arrive as local-midnight Date objects or ISO strings.
// Nullable dates and an absent branch allowance have one canonical snapshot.
function entitlementQuote(payment) {
  const count = Number(payment.extra_store_count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw staleQuote();
  try {
    return {
      from: payment.service_period_from == null ? null : databaseDateISO(payment.service_period_from),
      to: payment.service_period_to == null ? null : databaseDateISO(payment.service_period_to),
      count,
    };
  } catch { throw staleQuote(); }
}

// Translate only our named constraints. Unknown database failures propagate.
function reservationError(error) {
  const constraints = {
    platform_promo_reservations_payment_unique: ["PROMO_RESERVATION_CONFLICT", "Bu to'lov uchun promokod band qilingan. To'lov holatini tekshiring."],
    platform_promo_reservations_payment_tenant_fk: ["PROMO_TENANT_MISMATCH", "To'lov ushbu biznesga tegishli emas."],
    platform_promo_reservations_promo_fk: ["PROMO_INACTIVE", "Promokod topilmadi. Boshqa promokod tanlang."],
    platform_promo_reservations_organization_fk: ["ORG_NOT_FOUND", "Biznes topilmadi."],
  };
  const known = constraints[error?.constraint];
  if (known && ["23505", "23503"].includes(error.code)) return new HttpError(409, known[1], known[0]);
  return error;
}

async function lockPayment(client, paymentId, organizationId) {
  // Lookup is not a decision. Lock organization -> payment -> promo everywhere.
  const target = (await client.query("SELECT organization_id FROM billing_payments WHERE id=$1", [paymentId])).rows[0];
  if (!target || (organizationId && target.organization_id !== organizationId)) throw new HttpError(404, "To'lov topilmadi", "PAYMENT_NOT_FOUND");
  const owner = (await client.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [target.organization_id])).rows[0];
  if (!owner) throw new HttpError(404, "Biznes topilmadi", "ORG_NOT_FOUND");
  const payment = (await client.query("SELECT * FROM billing_payments WHERE id=$1 AND organization_id=$2 FOR UPDATE", [paymentId, target.organization_id])).rows[0];
  if (!payment) throw new HttpError(404, "To'lov topilmadi", "PAYMENT_NOT_FOUND");
  return payment;
}

async function attachedReservation(client, payment) {
  // Payment lock serializes transitions; promo lock serializes global capacity.
  const reservation = (await client.query("SELECT * FROM platform_promo_reservations WHERE payment_id=$1 AND organization_id=$2", [payment.id, payment.organization_id])).rows[0];
  if (reservation) await client.query("SELECT id FROM platform_promos WHERE id=$1 FOR UPDATE", [reservation.promo_id]);
  return reservation;
}

export async function reservePromo(client, { paymentId, organizationId }) {
  const payment = await lockPayment(client, paymentId, organizationId);
  const existing = await attachedReservation(client, payment);
  if (existing) return existing; // Retry retains the immutable quote after deactivation.
  if (payment.status !== "REVIEW") throw new HttpError(409, "To'lov tekshiruvda emas. Yangi to'lov yarating.", "PROMO_PAYMENT_TERMINAL");
  const draft = payment.draft_id ? (await client.query("SELECT * FROM billing_drafts WHERE id=$1 AND organization_id=$2", [payment.draft_id, payment.organization_id])).rows[0] : null;
  if (!draft?.metadata?.promoCode) return null;
  if (payment.type !== "LICENSE" || draft.type !== "LICENSE") throw new HttpError(409, "Promokod faqat tarif uchun qo'llanadi", "PROMO_LICENSE_ONLY");
  if (!["open", "submitted"].includes(draft.status) || (draft.status === "open" && new Date(draft.expires_at).getTime() <= Date.now())) throw staleQuote();
  const promo = await lockValidPromo(client, { code: draft.metadata.promoCode, plan: payment.plan, organizationId: payment.organization_id });
  const discount = discountForAmount(draft.base_amount, promo.discount_percent);
  if (draft.metadata.promoId !== promo.id || Number(draft.metadata.promoDiscountPercent) !== Number(promo.discount_percent) ||
      Number(draft.metadata.promoDiscount) !== discount || draft.plan !== payment.plan ||
      Number(draft.total_amount) !== Number(draft.base_amount) + Number(draft.extra_store_amount) - discount ||
      Number(payment.amount) !== Number(draft.total_amount)) throw staleQuote();
  const quote = entitlementQuote(payment);
  try {
    return (await client.query(`INSERT INTO platform_promo_reservations
      (promo_id,organization_id,payment_id,plan,discount_amount,quote_amount,quote_service_period_from,quote_service_period_to,quote_extra_store_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [promo.id, payment.organization_id, payment.id, payment.plan, discount, payment.amount, quote.from, quote.to, quote.count])).rows[0];
  } catch (error) { throw reservationError(error); }
}

export async function consumePromoReservation(client, paymentId) {
  const payment = await lockPayment(client, paymentId);
  const reservation = await attachedReservation(client, payment);
  if (!reservation) {
    const draft = payment.draft_id ? (await client.query("SELECT metadata FROM billing_drafts WHERE id=$1 AND organization_id=$2", [payment.draft_id, payment.organization_id])).rows[0] : null;
    if (draft?.metadata?.promoCode) throw new HttpError(409, "Promokod band qilinmagan. To'lovni tekshiring.", "PROMO_RESERVATION_MISSING");
    return null;
  }
  if (reservation.status === "CONSUMED") return reservation;
  if (reservation.status === "RELEASED" || payment.status !== "APPROVED") throw new HttpError(409, "Promokodni faqat tasdiqlangan to'lov ishlatishi mumkin", "PROMO_RESERVATION_STATE");
  if (payment.type !== "LICENSE" || payment.plan !== reservation.plan || Number(payment.amount) !== Number(reservation.quote_amount)) throw staleQuote();
  const quote = entitlementQuote(payment);
  const reservedQuote = entitlementQuote({
    service_period_from: reservation.quote_service_period_from,
    service_period_to: reservation.quote_service_period_to,
    extra_store_count: reservation.quote_extra_store_count,
  });
  if (quote.from !== reservedQuote.from || quote.to !== reservedQuote.to || quote.count !== reservedQuote.count) throw staleQuote();
  await consumePromo(client, { promo: { id: reservation.promo_id }, organizationId: payment.organization_id, paymentId, plan: reservation.plan, discountAmount: reservation.discount_amount });
  return (await client.query(`UPDATE platform_promo_reservations SET status='CONSUMED',consumed_at=now()
    WHERE payment_id=$1 AND organization_id=$2 AND status='RESERVED' RETURNING *`, [paymentId, payment.organization_id])).rows[0];
}

export async function releasePromoReservation(client, paymentId, reason = "TERMINAL") {
  const payment = await lockPayment(client, paymentId);
  const reservation = await attachedReservation(client, payment);
  if (!reservation || reservation.status !== "RESERVED") return reservation || null;
  if (["REVIEW", "APPROVED"].includes(payment.status)) throw new HttpError(409, "Avval to'lov tekshiruvini yakunlang", "PROMO_PAYMENT_PENDING");
  return (await client.query(`UPDATE platform_promo_reservations SET status='RELEASED',released_at=now(),release_reason=$3
    WHERE payment_id=$1 AND organization_id=$2 AND status='RESERVED' RETURNING *`, [paymentId, payment.organization_id, String(reason || "TERMINAL").trim().slice(0, 250) || "TERMINAL"])).rows[0];
}
