// Operator-run, read-only audit of legacy return movement cost provenance.
// Run with an explicit audited database URL. No table changes or tenant output.
import pg from 'pg';
import {pathToFileURL} from 'node:url';

export const LEGACY_RETURN_COST_SQL = `
WITH legacy AS (
  SELECT r.id, r.quantity::numeric AS returned_qty,
         sm.quantity::numeric AS movement_qty,
         (sm.after_quantity - sm.before_quantity)::numeric AS inventory_qty_delta,
         sm.unit_cost::numeric AS return_movement_cost,
         original.unit_cost::numeric AS original_sale_cost
  FROM sale_returns r
  LEFT JOIN LATERAL (
    SELECT m.quantity, m.before_quantity, m.after_quantity, m.unit_cost
    FROM stock_movements m
    WHERE m.organization_id = r.organization_id
      AND m.store_id = r.store_id
      AND m.product_id = r.product_id
      AND m.reference_type = 'return'
      AND m.reference_id = r.id::text
    ORDER BY m.created_at, m.id LIMIT 1
  ) sm ON true
  LEFT JOIN LATERAL (
    SELECT m.unit_cost
    FROM stock_movements m
    WHERE m.organization_id = r.organization_id
      AND m.store_id = r.store_id
      AND m.product_id = r.product_id
      AND m.reference_type = 'sale'
      AND m.reference_id = r.sale_id::text
    ORDER BY m.created_at, m.id LIMIT 1
  ) original ON true
  WHERE r.metadata->>'unitCost' IS NULL
)
SELECT COUNT(*)::int AS legacy_returns,
       COUNT(*) FILTER (WHERE movement_qty IS NULL)::int AS missing_return_movement,
       COUNT(*) FILTER (WHERE original_sale_cost IS NULL)::int AS missing_original_sale_cost,
       COUNT(*) FILTER (
         WHERE movement_qty IS DISTINCT FROM returned_qty
            OR inventory_qty_delta IS DISTINCT FROM returned_qty
       )::int AS inventory_quantity_mismatches,
       COUNT(*) FILTER (
         WHERE return_movement_cost=0 AND original_sale_cost>0
       )::int AS historical_zero_cost_discrepancies,
       COALESCE(SUM(returned_qty*original_sale_cost),0)::text AS original_cogs_reversal,
       COALESCE(SUM(returned_qty*return_movement_cost),0)::text AS historical_movement_value
FROM legacy
`;

export async function auditLegacyReturnCosts(client) {
  // Transaction-level READ ONLY is a database-enforced safety boundary.
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const {rows} = await client.query(LEGACY_RETURN_COST_SQL);
    const result = rows[0];
    await client.query('COMMIT');
    return {
      ...result,
      historical_cost_provenance_requires_manual_review:
        Number(result.historical_zero_cost_discrepancies)>0,
      note:'Original sale COGS and legacy movement value are NOT proof of current stock or profit variance.',
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connectionString=process.env.RETURN_COST_AUDIT_DATABASE_URL;
  if (!connectionString) {
    console.error('Set RETURN_COST_AUDIT_DATABASE_URL securely. No database was accessed.');
    process.exitCode=2;
  } else {
    const client=new pg.Client({connectionString,connectionTimeoutMillis:8000,statement_timeout:15000});
    try {
      await client.connect();
      const summary=await auditLegacyReturnCosts(client);
      console.log(JSON.stringify(summary,null,2));
      if(summary.missing_original_sale_cost||summary.missing_return_movement||summary.inventory_quantity_mismatches)process.exitCode=1;
    } catch {
      // The connection may contain secrets; never echo raw driver error objects.
      console.error('Read-only legacy return cost audit failed. Check database connectivity and query/schema compatibility.');
      process.exitCode=1;
    } finally {await client.end().catch(()=>{});}
  }
}
