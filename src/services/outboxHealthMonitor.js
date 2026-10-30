import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { isFinancialWriteMaintenance } from "./workerMaintenanceGate.js";

// Read-only aggregate health; never include tenant IDs, messages or payment data in alerts.
export const OUTBOX_HEALTH_SQL = `
  SELECT
    (SELECT count(*)::int FROM notification_outbox WHERE status='failed') AS outbox_failed,
    (SELECT count(*)::int FROM notification_deliveries WHERE status='failed') AS delivery_failed,
    (SELECT count(*)::int FROM notification_outbox n
      WHERE (n.status IN ('pending','retry','processing')
             AND n.next_attempt_at < now() - interval '15 minutes')
         OR (n.status = 'delivering'
             AND n.created_at < now() - interval '15 minutes'
             AND NOT EXISTS (
               SELECT 1 FROM notification_deliveries d
               WHERE d.outbox_id = n.id
                 AND d.status IN ('pending','retry','processing')
             ))) AS stale_outbox,
    (SELECT count(*)::int FROM notification_deliveries
      WHERE status IN ('pending','retry','processing')
        AND next_attempt_at < now() - interval '15 minutes') AS stale_deliveries
`;

const count = (value) => Math.max(0, Number(value) || 0);
export const summarizeOutboxHealth = (row = {}) => ({
  failed: count(row.outbox_failed) + count(row.delivery_failed),
  stale: count(row.stale_outbox) + count(row.stale_deliveries),
});

async function sendAdminAlert(message) {
  if (!env.paymentBotToken || !env.paymentAdminChatId) return false;
  const response = await fetch(`https://api.telegram.org/bot${env.paymentBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.paymentAdminChatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Telegram alert transport HTTP ${response.status}`);
  const reply = await response.json().catch(() => ({}));
  if (!reply.ok) throw new Error("Telegram admin alert rejected");
  return true;
}

export function createOutboxHealthMonitor({
  query,
  send,
  now = Date.now,
  warn = console.warn,
  error = console.error,
  cooldownMs = 60 * 60_000,
} = {}) {
  let inFlight = false;
  let lastAlertAt = -Infinity;
  let lastAlertType = "";
  let unhealthy = false;
  let consecutiveFailures = 0;
  let maintenanceLoggedAt = -Infinity;
  const alertOnce = async (type, message) => {
    if (type === lastAlertType && now() - lastAlertAt < cooldownMs) return;
    try {
      const delivered = await send(message);
      if (delivered === false) {
        warn("[worker-alerts] admin channel not configured");
        return;
      }
      lastAlertType = type;
      lastAlertAt = now();
    } catch {
      // Never log Telegram credentials, response bodies or per-tenant information.
      error("[worker-alerts] admin alert delivery failed");
    }
  };

  return async function check() {
    if (inFlight) return false;
    inFlight = true;
    try {
      const result = await query(OUTBOX_HEALTH_SQL);
      consecutiveFailures = 0;
      const { failed, stale } = summarizeOutboxHealth(result.rows?.[0]);
      if (failed || stale) {
        unhealthy = true;
        warn(`[worker-alerts] failed=${failed} stale_15m=${stale}`);
        await alertOnce("outbox", `ZENIX POS: Telegram navbatida muammo. Xato xabarlar: ${failed}; 15 daqiqadan oshgan navbat: ${stale}. Render va Neon monitoringini tekshiring.`);
      } else if (unhealthy) {
        unhealthy = false;
        warn("[worker-alerts] queue recovered");
        await alertOnce("recovered", "ZENIX POS: Telegram xabarnoma navbati tiklandi.");
      }
      return true;
    } catch (cause) {
      if (isFinancialWriteMaintenance(cause)) {
        if (now() - maintenanceLoggedAt >= cooldownMs) {
          warn("[worker-alerts:maintenance] database write pause; no failure alert");
          maintenanceLoggedAt = now();
        }
        return false;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        error("[worker-alerts] outbox monitoring query failed repeatedly");
        await alertOnce("monitor-unavailable", "ZENIX POS: Telegram xabarnoma navbatining monitoring so‘rovi ishlamayapti. Render/Neon ulanishini tekshiring.");
      }
      return false;
    } finally {
      inFlight = false;
    }
  };
}

export function startOutboxHealthMonitor({
  db = pool,
  send = sendAdminAlert,
  intervalMs = 5 * 60_000,
} = {}) {
  const check = createOutboxHealthMonitor({ query: (sql) => db.query(sql), send });
  // Emit readiness without ever printing secret values or tenant metadata.
  if (send === sendAdminAlert && (!env.paymentBotToken || !env.paymentAdminChatId)) {
    console.warn("[worker-alerts] admin Telegram channel not configured; queue alerts cannot be delivered");
  } else {
    console.info("[worker-alerts] outbox monitor started; 5-minute interval, 15-minute stale threshold");
  }
  const active = new Set();
  const run = () => {
    const task = check();
    active.add(task);
    void task.finally(() => active.delete(task));
    return task;
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return {
    timer,
    async stop() { clearInterval(timer); await Promise.allSettled([...active]); },
  };
}
