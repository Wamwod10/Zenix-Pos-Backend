import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDatabaseReady } from '../src/db/readiness.js';
import { REQUIRED_MIGRATIONS } from '../src/db/verifySchema.js';

test('readiness is true only when all required migrations have been applied', async () => {
  const db = { query: async (sql, params) => {
    assert.match(sql, /FROM schema_migrations/);
    assert.deepEqual(params, [REQUIRED_MIGRATIONS]);
    return { rows: REQUIRED_MIGRATIONS.map(name => ({ name })) };
  }};
  assert.equal(await assertDatabaseReady(db), true);
});
test('readiness fails closed for incomplete schema even though the database is reachable', async () => {
  const db = { query: async () => ({ rows: REQUIRED_MIGRATIONS.slice(0,-1).map(name => ({ name })) }) };
  await assert.rejects(assertDatabaseReady(db), { code: 'SCHEMA_NOT_READY' });
});
test('readiness fails closed if schema_migrations is missing', async () => {
  const db = { query: async () => { const error = new Error('relation does not exist'); error.code='42P01'; throw error; } };
  await assert.rejects(assertDatabaseReady(db), { code: '42P01' });
});
