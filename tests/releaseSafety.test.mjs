import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {RECOVERY_ROW_SOURCES} from '../src/services/tenantRecovery.js';
test('restore manifest includes paid-service provenance, POS workplaces, quota and shared budgets',()=>{
 for(const table of ['subscription_terms','subscription_events','pos_registers','ai_monthly_usage','ai_requests']){
  const source=RECOVERY_ROW_SOURCES.find(s=>s.table===table);assert.ok(source,table);assert.equal(source.where,'t.organization_id=$1');
  if(table==='ai_requests'){assert.match(source.key,/user_id/);assert.match(source.key,/request_id/)}
  if(table==='ai_monthly_usage')assert.match(source.key,/period_start/);
 }
 for(const table of ['subscription_plan_versions','ai_daily_budget'])assert.ok(RECOVERY_ROW_SOURCES.some(s=>s.table===table&&s.where==='TRUE'),table);
});
test('CI explicitly gates modern billing/resources/AI and fresh additive migration replay',async()=>{
 const source=await fs.readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');
 for(const flag of ['SUBSCRIPTION_TEST_DATABASE_URL','RESOURCE_TEST_DATABASE_URL','AI_TEST_DATABASE_URL','RELEASE_TEST_DATABASE_URL','SUBSCRIPTION_MIGRATION_TEST_DATABASE_URL'])assert.ok(source.includes(flag),flag);
 for(const file of ['subscriptionDatabase.test.mjs','resourceLimitsDatabase.test.mjs','aiDatabase.test.mjs','releaseIntegration.test.mjs','subscriptionMigration.test.mjs'])assert.ok(source.includes(file),file);
 assert.match(source,/--test-concurrency=1/);assert.match(source,/createdb[^\n]*zenix_ci_subscription_migration_test/);
});
