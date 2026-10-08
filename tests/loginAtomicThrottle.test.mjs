import test from 'node:test';
import assert from 'node:assert/strict';
import { recordLoginDecision } from '../src/services/loginThrottle.js';

// Simulates PostgreSQL transaction-scoped advisory locks: each concurrent
// request needs to wait for the preceding one to commit before counting rows.
const makeDb = () => {
  const attempts = [];
  let tail = Promise.resolve();
  return {
    attempts,
    async query() {},
    async connect() {
      let unlock;
      let committed = false;
      return {
        async query(sql, args = []) {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) {
            const previous = tail;
            tail = new Promise((resolve) => { unlock = resolve; });
            await previous;
          }
          if (sql.startsWith('SELECT count(*)')) {
            const [username, second] = args;
            const count = attempts.filter(x => x.username === username && !x.success &&
              (args.length === 2 || x.ip === second)).length;
            return { rows: [{ failures: count }] };
          }
          if (sql.startsWith('INSERT INTO auth_login_attempts')) {
            attempts.push({ username: args[0], ip: args[1], success: args[2] });
          }
          if (sql.startsWith('DELETE FROM auth_login_attempts WHERE username_norm')) {
            for (let i = attempts.length - 1; i >= 0; i--) {
              if (attempts[i].username === args[0] && !attempts[i].success) attempts.splice(i, 1);
            }
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            committed = true;
            unlock?.();
          }
          return { rows: [] };
        },
        release() { assert.equal(committed, true); },
      };
    },
  };
};

test('30 concurrent failed IP-rotating attempts cannot exceed account budget', async () => {
  const db = makeDb();
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) =>
    recordLoginDecision(db, { usernameNorm: 'cashier', ipAddress: `192.0.2.${i}`, success: false })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 30);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason?.code === 'LOGIN_RATE_LIMITED').length, 10);
  assert.equal(db.attempts.length, 30);
});

test('same-IP attempts never exceed per-IP failed budget', async () => {
  const db = makeDb();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
    recordLoginDecision(db, { usernameNorm: 'cashier', ipAddress: '192.0.2.1', success: false })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 8);
  assert.equal(db.attempts.length, 8);
});

test('successful login atomically clears old failures', async () => {
  const db = makeDb();
  await recordLoginDecision(db, { usernameNorm: 'cashier', ipAddress: '192.0.2.1', success: false });
  await recordLoginDecision(db, { usernameNorm: 'cashier', ipAddress: '192.0.2.1', success: true });
  assert.equal(db.attempts.filter(x => !x.success).length, 0);
});

test('session creation uses a transaction-scoped user lock before bounded cleanup', async () => {
  const { readFileSync } = await import('node:fs');
  const auth = readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');
  assert.match(auth, /session:\$\{userId\}/);
  assert.match(auth, /const token=await withTransaction\(\(client\)=>createSession\(client,user\.id,req\)\)/);
  assert.match(auth, /ORDER BY created_at DESC OFFSET 20/);
});
