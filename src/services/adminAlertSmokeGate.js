// A platform-admin-only, no-database smoke gate. One in-flight Telegram send
// per process and a cooldown prevent accidental duplicate admin TEST ALERTs.
export function createAdminAlertSmokeGate({
  send,
  now = Date.now,
  successCooldownMs = 5 * 60_000,
  failureCooldownMs = 60_000,
} = {}) {
  let inFlight = false;
  let nextAllowedAt = 0;
  return async ({token,chatId} = {}) => {
    if (!token || !chatId) return {ok:false,reason:"missing_configuration"};
    if (inFlight || now() < nextAllowedAt) return {ok:false,reason:"rate_limited"};
    inFlight = true;
    try {
      const result = await send({token,chatId});
      nextAllowedAt = now() + (result.ok ? successCooldownMs : failureCooldownMs);
      return result;
    } catch {
      nextAllowedAt = now() + failureCooldownMs;
      return {ok:false,reason:"transport_unavailable"};
    } finally {
      inFlight = false;
    }
  };
}
