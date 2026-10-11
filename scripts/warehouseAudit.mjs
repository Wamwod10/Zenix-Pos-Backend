import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {checkMigrationStatus} from '../src/db/migrationRunner.js';
import {verifyDatabaseSchema} from '../src/db/verifySchema.js';

const migrationDirectory=fileURLToPath(new URL('../migrations/',import.meta.url));
export async function auditWarehouseMigration(client,{phase}={}){
 if(!['before','after'].includes(phase))throw new Error('Usage: node scripts/warehouseAudit.mjs before|after');
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='60s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  const status=await checkMigrationStatus({db:client,directory:migrationDirectory});
  const fresh=['031_branch_warehouses.sql','032_warehouse_balance_presence.sql'];
  const upgrade=['032_warehouse_balance_presence.sql'];
  const pending=JSON.stringify(status.missing);
  const allowed=phase==='after'?pending==='[]':pending===JSON.stringify(fresh)||pending===JSON.stringify(upgrade);
  if(status.tableMissing||status.drifted.length||status.unverified.length||status.unknown.length||!allowed)throw new Error('Migration catalog failed: require matching checksums and only 031+032 or 032 pending before, no pending migrations after');
  const filename=phase==='after'?'032_warehouse_integrity.sql':pending===JSON.stringify(fresh)?'031_warehouse_preflight.sql':'032_warehouse_preflight.sql';
  const source=await readFile(new URL(`./sql/${filename}`,import.meta.url),'utf8');
  // Keep checks and catalog on the same read-only snapshot.
  const sql=source.replace(/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
  const result=await client.query(sql);
  const checks=(Array.isArray(result)?result:[result]).flatMap(item=>item.rows||[]);
  if(!checks.length||checks.some(row=>typeof row.check_name!=='string'||!/^[0-9]+$/.test(String(row.violations))||BigInt(row.violations)!==0n))throw new Error(`Warehouse ${phase} integrity failed: ${checks.filter(row=>String(row.violations)!=='0').map(row=>row.check_name).join(', ')||'invalid audit result'}`);
  if(phase==='after'){
   // The verifier normally parallelizes over a pool. Keep this one snapshot
   // on a single connection without issuing concurrent Client queries.
   let queue=Promise.resolve();
   await verifyDatabaseSchema({query:(...args)=>{
    const result=queue.then(()=>client.query(...args));
    queue=result.then(()=>undefined,()=>undefined);
    return result;
   }});
  }
  const identity=(await client.query('SELECT current_database() AS database')).rows[0];
  await client.query('COMMIT');
  return {ok:true,phase,database:identity.database,checks};
 }catch(error){await client.query('ROLLBACK');throw error}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const phase=process.argv[2];
 if(!['before','after'].includes(phase)){console.error('Usage: node scripts/warehouseAudit.mjs before|after');process.exitCode=1}
 else{
  const {migrationPool}=await import('../src/db/migrationPool.js');
  let client;
  try{client=await migrationPool.connect();console.log(JSON.stringify(await auditWarehouseMigration(client,{phase}),null,2))}
  catch(error){console.error(`[warehouse:audit] ${error.message}`);process.exitCode=1}
  finally{client?.release();await migrationPool.end()}
 }
}
