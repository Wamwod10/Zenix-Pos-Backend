import test from 'node:test';
import assert from 'node:assert/strict';
import {auditLegacyReturnCosts,LEGACY_RETURN_COST_SQL} from '../scripts/auditLegacyReturnCosts.mjs';

test('legacy return report enforces a read-only transaction and flags provenance discrepancies',async()=>{
  const queries=[];
  const client={query:async sql=>{
    queries.push(sql);
    if(sql===LEGACY_RETURN_COST_SQL)return{rows:[{
      legacy_returns:3,missing_return_movement:0,missing_original_sale_cost:0,
      inventory_quantity_mismatches:0,historical_zero_cost_discrepancies:3,
      original_cogs_reversal:'143000.00000',historical_movement_value:'0.00000'
    }]};
    return {rows:[]};
  }};
  const result=await auditLegacyReturnCosts(client);
  assert.deepEqual(queries,['BEGIN TRANSACTION READ ONLY',LEGACY_RETURN_COST_SQL,'COMMIT']);
  assert.equal(result.historical_cost_provenance_requires_manual_review,true);
  assert.match(result.note,/NOT proof of current stock or profit variance/);
  assert.match(LEGACY_RETURN_COST_SQL,/LEFT JOIN LATERAL/);
  assert.doesNotMatch(LEGACY_RETURN_COST_SQL,/\b(?:UPDATE|DELETE|INSERT|TRUNCATE|ALTER)\b/i);
});
test('read-only audit rolls back on query failures',async()=>{
  const seen=[];
  const client={query:async sql=>{seen.push(sql);if(sql===LEGACY_RETURN_COST_SQL)throw new Error('synthetic query failure');return {rows:[]}}};
  await assert.rejects(auditLegacyReturnCosts(client),/synthetic query failure/);
  assert.deepEqual(seen,['BEGIN TRANSACTION READ ONLY',LEGACY_RETURN_COST_SQL,'ROLLBACK']);
});
