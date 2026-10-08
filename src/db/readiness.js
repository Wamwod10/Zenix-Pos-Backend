import { REQUIRED_MIGRATIONS } from './verifySchema.js';

// The infrastructure health endpoint must not report ready simply because
// PostgreSQL accepts SELECT 1: an unmigrated API cannot safely serve writes.
// Read-only, inexpensive and safe for pooled runtime connections.
export async function assertDatabaseReady(db) {
  const rows = (await db.query('SELECT name FROM schema_migrations WHERE name = ANY($1::text[])', [REQUIRED_MIGRATIONS])).rows;
  const applied = new Set(rows.map(row => row.name));
  const missing = REQUIRED_MIGRATIONS.filter(name => !applied.has(name));
  if (missing.length) {
    const error = new Error('Database migrations are incomplete');
    error.code = 'SCHEMA_NOT_READY';
    throw error;
  }
  return true;
}
