import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { enqueuePaymentReviewUpdate, paymentReviewSnapshot } from './paymentNotifications.js';
import { derivePaymentReviewToken, hashPaymentReviewToken, sendPaymentReview, editPaymentReviewMessage, formatPaymentReviewMessage } from "./paymentTelegram.js";

const batchSize = 10;
let running = false;

export const paymentRetryState = (attempts, error) => {
  const nextAttempts = Number(attempts || 0) + 1;
  return {
    status: nextAttempts >= 8 ? "failed" : "retry",
    attempts: nextAttempts,
    delaySeconds: Math.min(3600, 30 * (2 ** Math.min(Number(attempts || 0), 6))),
    lastError: String(error?.message || error || "Telegram xatosi").slice(0, 1000),
  };
};

async function claimEvents(db) {
  return (await db.query(`WITH candidates AS (
    SELECT id FROM notification_outbox
    WHERE event_type IN ('billing.payment_review','billing.payment_review_updated') AND ((status IN ('pending','retry') AND next_attempt_at<=now())
      OR (status='processing' AND next_attempt_at<=now()-interval '10 minutes'))
    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
  ) UPDATE notification_outbox n SET status='processing',next_attempt_at=now()
    FROM candidates c WHERE n.id=c.id RETURNING n.*`, [batchSize])).rows;
}

async function paymentContext(db, event) {
  return (await db.query(`SELECT bp.*,o.name AS organization_name,o.store_limit,bd.metadata AS draft_metadata,
      owner.name AS owner_name,owner.phone AS owner_phone,review.metadata AS review_actor,review.user_id AS review_user_id,
      br.file_name AS receipt_name,br.mime_type AS receipt_type,br.content AS receipt_content
    FROM billing_payments bp
    JOIN organizations o ON o.id=bp.organization_id
    LEFT JOIN billing_drafts bd ON bd.id=bp.draft_id AND bd.organization_id=bp.organization_id
    LEFT JOIN LATERAL (SELECT u.name,u.phone FROM users u WHERE u.organization_id=o.id AND u.app_role='OWNER' ORDER BY u.created_at LIMIT 1) owner ON true
    LEFT JOIN billing_receipts br ON br.id=bp.receipt_id AND br.organization_id=bp.organization_id
    LEFT JOIN LATERAL (SELECT a.metadata,a.user_id FROM audit_logs a WHERE a.organization_id=bp.organization_id
      AND a.entity_type='billing_payment' AND a.entity_id=bp.id::text AND a.action IN ('approve','reject') ORDER BY a.created_at DESC LIMIT 1) review ON true
    WHERE bp.id=$1 AND bp.organization_id=$2`, [event.payload?.paymentId || event.event_id, event.organization_id])).rows[0] || null;
}

async function markFailure(db, event, error) {
  const retry = paymentRetryState(event.attempts, error);
  await db.query(`UPDATE notification_outbox SET status=$2,attempts=$3,last_error=$4,
    next_attempt_at=now()+make_interval(secs=>$5) WHERE id=$1`, [event.id, retry.status, retry.attempts, retry.lastError, retry.delaySeconds]);
}

export async function deliverPaymentEvent(db, event, telegramSend = sendPaymentReview, telegramEdit = editPaymentReviewMessage) {
  if (event.event_type === 'billing.payment_review_updated') {
    const {payment,actor,chatId,messageId,hasCaption,detailsMessageId} = event.payload;
    await telegramEdit(chatId,messageId,formatPaymentReviewMessage(payment,actor),{hasCaption,detailsMessageId,
      onDetailsMessage:async id => db.query('UPDATE notification_outbox SET payload=payload||$2::jsonb WHERE id=$1',[event.id,JSON.stringify({detailsMessageId:id})])});
    await db.query("UPDATE notification_outbox SET status='sent',sent_at=now(),attempts=attempts+1,last_error='' WHERE id=$1",[event.id]);
    return;
  }
  const current = await paymentContext(db, event);
  const payment = current ? {...current,...event.payload?.reviewSnapshot,status:current.status,reviewed_at:current.reviewed_at,reject_reason:current.reject_reason} : null;
  if (!payment || payment.status !== "REVIEW") {
    if(payment)await reconcileReview(db,payment,event.payload?.hasCaption ?? Boolean(payment.receipt_id));
    await db.query("UPDATE notification_outbox SET status='sent',sent_at=COALESCE(sent_at,now()),last_error='' WHERE id=$1", [event.id]);
    return;
  }
  if (payment.telegram_notification_sent_at && payment.telegram_admin_message_id) {
    await db.query("UPDATE notification_outbox SET status='sent',sent_at=COALESCE(sent_at,now()),last_error='' WHERE id=$1", [event.id]);
    return;
  }
  const token = derivePaymentReviewToken(payment.id, env.paymentWebhookSecret);
  const tokenHash = hashPaymentReviewToken(token);
  await db.query(`UPDATE billing_payments SET telegram_review_token_hash=$2,
    telegram_review_token_expires_at=now()+interval '30 days' WHERE id=$1 AND status='REVIEW'`, [payment.id, tokenHash]);
  const snapshot=event.payload?.reviewSnapshot || paymentReviewSnapshot(payment);
  await db.query('UPDATE notification_outbox SET payload=payload||$2::jsonb WHERE id=$1',[event.id,JSON.stringify({reviewSnapshot:snapshot})]);
  const message = await telegramSend(payment, token, env.paymentAdminChatId);
  await db.query(`WITH message_kind AS (
    UPDATE notification_outbox SET payload=payload||$5::jsonb WHERE id=$4 RETURNING id
  ) UPDATE billing_payments SET telegram_admin_chat_id=$2,telegram_admin_message_id=$3,
    telegram_notification_sent_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM message_kind)`,
  [payment.id, String(message.chat?.id || env.paymentAdminChatId), String(message.message_id),event.id,JSON.stringify({hasCaption:Boolean(message.photo || message.document)})]);
  // An admin can finish review while Telegram is sending the initial card.
  // Re-read after saving its IDs, so that decision always receives a final edit.
  const latest=await paymentContext(db,event);
  if(latest)await reconcileReview(db,{...latest,...snapshot,status:latest.status,reviewed_at:latest.reviewed_at,reject_reason:latest.reject_reason},Boolean(message.photo || message.document));
  await db.query("UPDATE notification_outbox SET status='sent',sent_at=now(),attempts=attempts+1,last_error='' WHERE id=$1", [event.id]);
}

async function reconcileReview(db,payment,hasCaption) {
  const metadata=payment.review_actor || {};
  await enqueuePaymentReviewUpdate(db,payment,{telegramUsername:metadata.telegram_admin_username,telegramUserId:metadata.telegram_admin_user_id,internalUserId:payment.review_user_id},
    {chatId:payment.telegram_admin_chat_id,messageId:payment.telegram_admin_message_id,hasCaption});
}

export async function processPaymentNotificationOutbox({ db = pool, telegramSend = sendPaymentReview } = {}) {
  if (running || !env.paymentBotToken || !env.paymentAdminChatId || !env.paymentWebhookSecret) return;
  running = true;
  try {
    const events = await claimEvents(db);
    for (const event of events) {
      try { await deliverPaymentEvent(db, event, telegramSend); }
      catch (error) { await markFailure(db, event, error); }
    }
  } finally { running = false; }
}

export function startPaymentNotificationWorker() {
  const activeRuns = new Set();
  const run = () => {
    const task = processPaymentNotificationOutbox().catch((error) => console.error("[payment-telegram-worker]", String(error?.message || error).slice(0, 300)));
    activeRuns.add(task);
    task.finally(() => activeRuns.delete(task));
    return task;
  };
  const timer = setInterval(run, 15_000);
  timer.unref?.();
  run();
  return {
    timer,
    async stop() { clearInterval(timer); await Promise.allSettled([...activeRuns]); },
  };
}
