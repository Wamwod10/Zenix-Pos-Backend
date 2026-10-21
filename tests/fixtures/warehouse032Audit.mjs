// Run the unchanged auditor against a historical catalog and schema contract.
// No runtime option is added to the production fail-closed auditor.
import {mkdtemp,copyFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadMigrationCatalog} from '../../src/db/migrationCatalog.js';
import {readDatabaseSchema} from '../../src/db/verifySchema.js';
import * as requirements from './warehouse032Requirements.mjs';
export async function verifyWarehouse032Schema(db){
 const snapshot=await readDatabaseSchema(db);
 const fields={tables:'TABLES',migrations:'MIGRATIONS',primaryKeyTables:'TABLES',foreignKeyTables:'FOREIGN_KEY_TABLES',uniqueConstraintTables:'UNIQUE_CONSTRAINT_TABLES',indexes:'INDEXES',tenantConstraints:'TENANT_CONSTRAINTS',columns:'COLUMNS',checks:'CHECKS',triggers:'TRIGGERS',deferredTriggers:'DEFERRED_TRIGGERS',uniqueIndexes:'UNIQUE_INDEXES'};
 const missing=Object.entries(fields).flatMap(([field,key])=>requirements['REQUIRED_'+key].filter(name=>!snapshot[field].includes(name)).map(name=>`${field}: ${name}`));
 if(missing.length)throw Error('Historical 032 schema verification failed: '+missing.join(', '));
 return snapshot;
}
export async function historicalWarehouseAudit(){
 const directory=await mkdtemp(join(tmpdir(),'zenix-warehouse032-'));
 try{
  const catalog=await loadMigrationCatalog(fileURLToPath(new URL('../../migrations/',import.meta.url)));
  for(const migration of catalog.filter(m=>m.prefix<='032'))await copyFile(new URL('../../migrations/'+migration.name,import.meta.url),join(directory,migration.name));
  let source=await readFile(new URL('../../scripts/warehouseAudit.mjs',import.meta.url),'utf8');
  source=source.replace("'../src/db/migrationRunner.js'",JSON.stringify(new URL('../../src/db/migrationRunner.js',import.meta.url).href))
   .replace("import {verifyDatabaseSchema} from '../src/db/verifySchema.js';",`import {verifyWarehouse032Schema as verifyDatabaseSchema} from ${JSON.stringify(import.meta.url)};`)
   .replace("fileURLToPath(new URL('../migrations/',import.meta.url))",JSON.stringify(directory))
   .replace('new URL(`./sql/${filename}`,import.meta.url)',`new URL(filename,${JSON.stringify(new URL('../../scripts/sql/',import.meta.url).href)})`);
  const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  return {audit:module.auditWarehouseMigration,close:()=>rm(directory,{recursive:true,force:true})};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error}
}
