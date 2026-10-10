// Read-only verifier for OFFLINE LOCAL exports of an isolated provider restore.
// It does not create snapshots, restore branches, or certify provider operations.
import {pathToFileURL} from 'node:url';
import {assertSafeTestDatabaseUrl} from './assertTestDatabase.js';
import {recoveryRowManifest,compareRecoveryRowManifests} from '../src/services/tenantRecovery.js';
import {auditTenantIntegrity} from '../src/db/auditIntegrity.js';
export function restoreDrillTargets(source,target){
 const targets=[source,target].map(value=>{const url=assertSafeTestDatabaseUrl(value);if(/prod|production|live/i.test(decodeURIComponent(url.pathname))||url.hash||[...url.searchParams.keys()].some(key=>key!=='sslmode'))throw Error('Unsafe recovery target');if(!url.port)url.port='5432';return url});
 const key=url=>`${url.port}:${decodeURIComponent(url.pathname)}`;
 if(key(targets[0])===key(targets[1]))throw Error('Independent database targets required');return targets;
}
export async function verifyRestoreDrill(sourcePool,targetPool){
 const ids=await Promise.all([sourcePool,targetPool].map(async pool=>(await pool.query('SELECT id FROM organizations ORDER BY id')).rows.map(row=>row.id)));
 if(JSON.stringify(ids[0])!==JSON.stringify(ids[1])||!ids[0].length)throw Error('Organization inventory mismatch or empty fixture');
 const tenants=[];
 for(const id of ids[0]){
  const [before,after]=await Promise.all([sourcePool,targetPool].map(pool=>recoveryRowManifest(pool,id)));
  const comparison=compareRecoveryRowManifests(before,after);tenants.push({tenantFingerprint:before.tenantFingerprint,matching:comparison.differences.length===0,changedTables:comparison.differences.map(row=>row.table)});
 }
 const integrity=await Promise.all([sourcePool,targetPool].map(async pool=>{const checks=await auditTenantIntegrity(pool);return {ok:Object.values(checks).every(value=>value===0),checks}}));
 return {kind:'LOCAL_RESTORED_COPY_COMPARISON',providerRestoreVerified:false,verifiedAt:new Date().toISOString(),tenants,integrity,
  complete:tenants.every(row=>row.matching)&&integrity.every(row=>row.ok===true),
  limitations:['Provider creation/restore operation evidence must be supplied separately.','Offline copies required; concurrent changes invalidate comparison.','Exact ledger and stock movement fingerprints are compared; this does not prove all business equations.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const pools=[];try{
  const urls=restoreDrillTargets(process.env.RECOVERY_SOURCE_DATABASE_URL,process.env.RECOVERY_TARGET_DATABASE_URL);
  const [{default:pg},{createMigrationPoolConfig}]=await Promise.all([import('pg'),import('../src/db/config.js')]);
  for(const url of urls)pools.push(new pg.Pool(createMigrationPoolConfig({databaseUrl:url.href,isProduction:false,connectionTimeoutMs:10000,statementTimeoutMs:10000,queryTimeoutMs:10000,idleTransactionTimeoutMs:10000})));
  const evidence=await verifyRestoreDrill(...pools);console.log(JSON.stringify(evidence,null,2));if(!evidence.complete)process.exitCode=1;
 }catch{console.error('RESTORE_DRILL_VERIFICATION_FAILED');process.exitCode=1}finally{await Promise.all(pools.map(pool=>pool.end()))}
}
