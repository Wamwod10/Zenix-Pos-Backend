import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {recoveryRowManifest,compareRecoveryRowManifests} from '../src/services/tenantRecovery.js';
import {auditTenantIntegrity} from '../src/db/auditIntegrity.js';
const url=process.env.RELEASE_RECOVERY_TEST_DATABASE_URL;
test('real PG restore manifests include all modern financial/quota/register state',{skip:!url},async()=>{
 assertSafeTestDatabaseUrl(url);const db=new pg.Pool({connectionString:url});
 try{
  const org=(await db.query('SELECT id FROM organizations ORDER BY id LIMIT 1')).rows[0]?.id;assert.ok(org,'Migrated synthetic fixture database required');
  const manifest=await recoveryRowManifest(db,org);
  assert.ok(Object.values(await auditTenantIntegrity(db)).every(count=>count===0));
  for(const table of ['subscription_terms','subscription_events','pos_registers','ai_monthly_usage','ai_requests','subscription_plan_versions','ai_daily_budget','financial_write_replays']){
   assert.ok(manifest.tables[table]);const changed=structuredClone(manifest);changed.tables[table].fingerprint='a'.repeat(64);
   assert.ok(manifest.tables[table].rows>0,`Populated synthetic restore fixture required: ${table}`);
   assert.ok(compareRecoveryRowManifests(manifest,changed).differences.some(d=>d.table===table));
  }
 }finally{await db.end()}
});
