import { loadMigrationCatalog } from "./migrationCatalog.js";
import { executeMigration } from "./migrationExecution.js";

const MIGRATION_LOCK_KEY="zenix-pos-schema-migrations-v1";
const lockSql="SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked";
const unlockSql="SELECT pg_advisory_unlock(hashtextextended($1,0))";

const wait=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));

async function acquireMigrationLock(client,{timeoutMs,pollMs}){
  const deadline=Date.now()+timeoutMs;
  while(true){
    const result=await client.query(lockSql,[MIGRATION_LOCK_KEY]);
    if(result.rows[0]?.locked!==false)return;
    if(Date.now()>=deadline)throw new Error(`Timed out waiting ${timeoutMs}ms for the migration lock`);
    await wait(pollMs);
  }
}

export async function runMigrations({pool,directory,logger=console,lockTimeoutMs=120_000,lockPollMs=100}){
  const catalog=await loadMigrationCatalog(directory);
  const client=await pool.connect();
  let locked=false;
  let primaryError=null;
  const applied=[];
  const adopted=[];
  try{
    await acquireMigrationLock(client,{timeoutMs:lockTimeoutMs,pollMs:lockPollMs});
    locked=true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text
    )`);
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const rows=(await client.query("SELECT name,checksum FROM schema_migrations ORDER BY name")).rows;
    const existing=new Map(rows.map((row)=>[row.name,row.checksum||null]));
    for(const migration of catalog){
      if(existing.has(migration.name)){
        const checksum=existing.get(migration.name);
        if(checksum&&checksum!==migration.checksum)throw new Error(`Migration checksum mismatch: ${migration.name}`);
        if(!checksum){
          await client.query("UPDATE schema_migrations SET checksum=$2 WHERE name=$1 AND checksum IS NULL",[migration.name,migration.checksum]);
          adopted.push(migration.name);
        }
        continue;
      }
      await executeMigration(client,migration);
      applied.push(migration.name);
      logger.log?.(`[migrate] ${migration.name}`);
    }
    return {applied,adopted,total:catalog.length};
  }catch(error){
    primaryError=error;
    throw error;
  }finally{
    let unlockError=null;
    if(locked){try{await client.query(unlockSql,[MIGRATION_LOCK_KEY])}catch(error){unlockError=error}}
    if(primaryError&&unlockError&&typeof primaryError==="object"){
      Object.defineProperty(primaryError,"unlockError",{value:unlockError,configurable:true});
    }
    client.release(unlockError||undefined);
    if(!primaryError&&unlockError)throw unlockError;
  }
}

export async function checkMigrationStatus({db,directory}){
  const catalog=await loadMigrationCatalog(directory);
  let rows=[];
  let tableMissing=false;
  try{
    rows=(await db.query("SELECT name,to_jsonb(schema_migrations)->>'checksum' AS checksum FROM schema_migrations ORDER BY name")).rows;
  }catch(error){
    if(error?.code!=="42P01")throw error;
    tableMissing=true;
  }
  const existing=new Map(rows.map((row)=>[row.name,row.checksum||null]));
  const known=new Set(catalog.map((migration)=>migration.name));
  return {
    tableMissing,
    missing:catalog.filter((migration)=>!existing.has(migration.name)).map((migration)=>migration.name),
    drifted:catalog.filter((migration)=>existing.get(migration.name)&&existing.get(migration.name)!==migration.checksum).map((migration)=>migration.name),
    unverified:catalog.filter((migration)=>existing.has(migration.name)&&!existing.get(migration.name)).map((migration)=>migration.name),
    unknown:rows.filter((row)=>!known.has(row.name)).map((row)=>row.name),
  };
}
