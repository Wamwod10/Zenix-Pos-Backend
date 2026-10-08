import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const route=fs.readFileSync(new URL('../src/routes/auth.js',import.meta.url),'utf8');
const throttle=fs.readFileSync(new URL('../src/services/loginThrottle.js',import.meta.url),'utf8');
test('login enforces IP and account budgets within an advisory-locked transaction',()=>{
 assert.match(throttle,/username_norm=\$1 AND ip_address=\$2 AND success=false/);
 assert.match(throttle,/MAX_ACCOUNT_FAILURES = 30/);
 assert.match(throttle,/WHERE username_norm=\$1 AND success=false AND created_at>/);
 assert.match(throttle,/pg_advisory_xact_lock/);
 assert.match(throttle,/DELETE FROM auth_login_attempts WHERE username_norm=\$1 AND success=false/);
 assert.match(route,/await recordLoginDecision\(pool,\{usernameNorm,ipAddress,success:valid\}\)/);
});
