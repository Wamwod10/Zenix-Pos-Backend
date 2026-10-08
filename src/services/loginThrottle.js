import { runTransaction } from "../db/tx.js";
import { HttpError } from "../lib/http.js";

const LOGIN_WINDOW = "15 minutes";
const MAX_IP_FAILURES = 8;
const MAX_ACCOUNT_FAILURES = 30;
const RATE_LIMIT_MESSAGE = "Juda ko‘p noto‘g‘ri urinish. Birozdan keyin qayta urinib ko‘ring.";

export async function assertLoginAllowed(db, usernameNorm, ipAddress) {
  const ip = (await db.query(`SELECT count(*)::int AS failures
    FROM auth_login_attempts
    WHERE username_norm=$1 AND ip_address=$2 AND success=false
      AND created_at>now()-$3::interval`, [usernameNorm, ipAddress, LOGIN_WINDOW])).rows[0];
  if (Number(ip?.failures || 0) >= MAX_IP_FAILURES) {
    throw new HttpError(429, RATE_LIMIT_MESSAGE, "LOGIN_RATE_LIMITED");
  }
  const account = (await db.query(`SELECT count(*)::int AS failures FROM auth_login_attempts
    WHERE username_norm=$1 AND success=false AND created_at>now()-$2::interval`, [usernameNorm, LOGIN_WINDOW])).rows[0];
  if (Number(account?.failures || 0) >= MAX_ACCOUNT_FAILURES) {
    throw new HttpError(429, RATE_LIMIT_MESSAGE, "LOGIN_RATE_LIMITED");
  }
}

// The initial fast check is for efficiency only. The authoritative check MUST
// run after taking this transaction-scoped lock; otherwise simultaneous requests
// from different IPs can all pass the account-wide threshold before recording.
export async function recordLoginDecision(db, { usernameNorm, ipAddress, success }) {
  const allowed = await runTransaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`login:${usernameNorm}`]);
    try {
      await assertLoginAllowed(client, usernameNorm, ipAddress);
    } catch (error) {
      if (error instanceof HttpError && error.code === "LOGIN_RATE_LIMITED") return false;
      throw error;
    }
    await client.query(`INSERT INTO auth_login_attempts(username_norm,ip_address,success) VALUES($1,$2,$3)`,
      [usernameNorm, ipAddress, Boolean(success)]);
    if (success) {
      await client.query("DELETE FROM auth_login_attempts WHERE username_norm=$1 AND success=false", [usernameNorm]);
    }
    return true;
  });
  // Cleanup is intentionally outside the login transaction: a failed cleanup
  // must not undo the durable rate-limit decision.
  db.query("DELETE FROM auth_login_attempts WHERE created_at<now()-interval '24 hours'").catch(() => {});
  if (!allowed) throw new HttpError(429, RATE_LIMIT_MESSAGE, "LOGIN_RATE_LIMITED");
}
