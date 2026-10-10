import { createHash } from 'node:crypto';

// Diagnostic inventory only. Identifiers/predicates are frozen here, never supplied
// by an operator. Child rows are scoped through their proven tenant-owned parent.
const scoped=table=>Object.freeze({table,key:'t.id',where:'t.organization_id=$1'});
const linked=(table,parent,foreignKey,key='t.id')=>Object.freeze({
  table,key,where:`EXISTS (SELECT 1 FROM ${parent} p WHERE p.id=t.${foreignKey} AND p.organization_id=$1)`,
});
export const RECOVERY_ROW_SOURCES=Object.freeze([
  Object.freeze({table:'organizations',key:'t.id',where:'t.id=$1'}),
  ...[
    'products','stores','users','customers','sales','sale_returns',
    'customer_ledger','customer_payment_allocations','customer_loyalty_ledger',
    'inventory_batches','product_serials','stock_movements','shifts','shift_movements',
    'suppliers','supplier_invoices','supplier_payments','expenses','stock_transfers',
    'inventory_counts','sale_holds','business_days','billing_drafts','billing_receipts',
    'billing_payments','telegram_link_tokens','telegram_connections','notification_outbox',
    'file_assets','audit_logs','platform_promo_uses','platform_promo_reservations','extra_store_entitlements',
  ].map(scoped),
  Object.freeze({table:'inventory_balances',key:"(t.store_id::text || ':' || t.product_id::text)",where:'t.organization_id=$1'}),
  Object.freeze({table:'workspace_revisions',key:'t.organization_id',where:'t.organization_id=$1'}),
  Object.freeze({table:'organization_trial_claims',key:'t.organization_id',where:'t.organization_id=$1'}),
  linked('sale_items','sales','sale_id'),
  linked('sale_payments','sales','sale_id'),
  linked('supplier_invoice_items','supplier_invoices','invoice_id'),
  linked('stock_transfer_items','stock_transfers','transfer_id'),
  linked('auth_sessions','users','user_id'),
  linked('password_reset_tokens','users','user_id'),
  linked('user_preferences','users','user_id','t.user_id'),
  linked('notification_deliveries','notification_outbox','outbox_id'),
]);
export const RECOVERY_ROW_TABLES=Object.freeze(RECOVERY_ROW_SOURCES.map(source=>source.table));
export const RECOVERY_MAX_ROWS_PER_TABLE=5000;
const SQL=Object.freeze(RECOVERY_ROW_SOURCES.map(({table,key,where})=>Object.freeze([
  table,`SELECT encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS fingerprint FROM ${table} t WHERE ${where} ORDER BY ${key} LIMIT $2`,
])));
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,code)=>Object.assign(new Error(message),{code});
const validFingerprint=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const warning='Read-only counts and fingerprints. Equality is diagnostic only; no repair or automated restore is authorized.';

export async function recoveryRowManifest(pool,organizationId,{limit=RECOVERY_MAX_ROWS_PER_TABLE}={}){
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(organizationId)))throw fail('Valid organization ID required','RECOVERY_INVALID_ORGANIZATION');
  if(!Number.isInteger(limit)||limit<1||limit>RECOVERY_MAX_ROWS_PER_TABLE)throw fail('Invalid recovery row limit','RECOVERY_INVALID_LIMIT');
  // Timeouts also belong on the pool so connection acquisition is bounded (CLI).
  let client,began=false;
  try{
    client=await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    if(!(await client.query('SELECT id FROM organizations WHERE id=$1 LIMIT 1',[organizationId])).rows.length)throw fail('Organization not found in snapshot','RECOVERY_ORGANIZATION_NOT_FOUND');
    const tables={};
    for(const [table,sql] of SQL){
      const {rows}=await client.query(sql,[organizationId,limit+1]);
      if(rows.length>limit)throw fail(`Recovery manifest row limit exceeded for ${table}`,'RECOVERY_LIMIT_EXCEEDED');
      const fingerprints=rows.map(row=>{
        if(!validFingerprint(row.fingerprint))throw fail('Invalid recovery fingerprint','RECOVERY_INVALID_FINGERPRINT');
        return row.fingerprint;
      }).sort();
      // Only a table-level digest leaves this function; no row keys or hashes.
      tables[table]={rows:rows.length,fingerprint:hash(JSON.stringify(fingerprints))};
    }
    await client.query('COMMIT');began=false;
    return {tenantFingerprint:hash(String(organizationId).toLowerCase()),tables,complete:true};
  }catch(error){
    if(began)await client.query('ROLLBACK').catch(()=>{});
    if(error?.code?.startsWith('RECOVERY_'))throw error;
    throw fail('Recovery read failed','RECOVERY_READ_FAILED');
  }finally{client?.release();}
}

const summary=(tables,table)=>{
  const value=tables?.[table];
  if(!value)throw fail(`Missing recovery table: ${table}`,'RECOVERY_MISSING_TABLE');
  if(!Number.isInteger(value.rows)||value.rows<0||value.rows>RECOVERY_MAX_ROWS_PER_TABLE||!validFingerprint(value.fingerprint))throw fail('Invalid recovery summary','RECOVERY_INVALID_SUMMARY');
  return {rows:value.rows,fingerprint:value.fingerprint};
};
const compare=(source,target,beforeTables,afterTables)=>{
  if(!validFingerprint(source?.tenantFingerprint)||source.tenantFingerprint!==target?.tenantFingerprint)throw fail('Recovery snapshot tenant mismatch','RECOVERY_TENANT_MISMATCH');
  const differences=[];
  for(const table of RECOVERY_ROW_TABLES){
    const before=summary(beforeTables,table),after=summary(afterTables,table);
    if(before.rows!==after.rows||before.fingerprint!==after.fingerprint)differences.push({table,before,after});
  }
  return differences;
};
export function compareRecoveryRowManifests(source,target){
  if(source?.complete!==true||target?.complete!==true)throw fail('Incomplete recovery manifest','RECOVERY_INCOMPLETE');
  return {differences:compare(source,target,source.tables,target.tables),warning};
}
// Both CLI modes use the same bounded inventory and full child coverage. No
// financial totals, organization names or original values are aggregated/emitted.
export async function recoverySnapshot(pool,organizationId){
  const {tenantFingerprint,tables}=await recoveryRowManifest(pool,organizationId);
  return {tenantFingerprint,metrics:tables};
}
export function compareRecoverySnapshots(source,target){
  const changes=compare(source,target,source?.metrics,target?.metrics);
  return {changes,changedTables:changes.map(change=>change.table),warning};
}
