// A deployment/migration may temporarily pause financial writes. This gate
// bounds repeated worker polls without mutating outbox rows or retry counters.
// Actual delivery retries remain owned by their existing database state machine.
export const isFinancialWriteMaintenance = (error) =>
  /financial writes paused/i.test(String(error?.message || error || ""));

export function createWorkerMaintenanceGate({
  name,
  now = Date.now,
  warn = console.warn,
  error = console.error,
  pauseMs = 60_000,
} = {}) {
  let pausedUntil = 0;
  let inFlight = false;
  let wasPaused = false;
  const workerName = String(name || "notification-worker");
  return async function run(task) {
    if (inFlight || now() < pausedUntil) return false;
    inFlight = true;
    try {
      await task();
      if (wasPaused) warn(`[${workerName}:maintenance] resumed after bounded pause`);
      wasPaused = false;
      pausedUntil = 0;
      return true;
    } catch (cause) {
      if (isFinancialWriteMaintenance(cause)) {
        pausedUntil = now() + Math.max(15_000, Math.min(300_000, pauseMs));
        wasPaused = true;
        warn(`[${workerName}:maintenance] financial writes paused; polling held temporarily`);
      } else {
        error(`[${workerName}]`, cause);
      }
      return false;
    } finally {
      inFlight = false;
    }
  };
}
