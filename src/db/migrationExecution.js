const NO_TRANSACTION_DIRECTIVE="-- migrate:no-transaction";

const splitStatements=(sql)=>sql
  .split(";")
  .map((statement)=>statement
    .split(/\r?\n/)
    .filter((line)=>line.trim()&&!line.trim().startsWith("--"))
    .join("\n")
    .trim())
  .filter(Boolean);

const concurrentIndexName=(statement)=>statement.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1]||null;

const removeInvalidConcurrentIndex=async(client,indexName)=>{
  const result=await client.query(`
    SELECT (index_row.indisvalid AND index_row.indisready) AS is_valid
    FROM pg_class index_class
    JOIN pg_index index_row ON index_row.indexrelid=index_class.oid
    JOIN pg_namespace namespace ON namespace.oid=index_class.relnamespace
    WHERE namespace.nspname=current_schema() AND index_class.relname=$1
  `,[indexName]);
  if(result.rows?.[0]?.is_valid===false){
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
  }
};

const migrationRecord=(migrationOrName,legacySql)=>typeof migrationOrName==="string"
  ? {name:migrationOrName,sql:legacySql,checksum:null}
  : migrationOrName;

const insertMigration=async(client,{name,checksum})=>checksum
  ? client.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",[name,checksum])
  : client.query("INSERT INTO schema_migrations(name) VALUES($1)",[name]);

export const executeMigration = async (client,migrationOrName,legacySql) => {
  const migration=migrationRecord(migrationOrName,legacySql);
  const {name,sql}=migration;
  if(sql.trimStart().startsWith(NO_TRANSACTION_DIRECTIVE)){
    for(const statement of splitStatements(sql)){
      const indexName=concurrentIndexName(statement);
      if(indexName)await removeInvalidConcurrentIndex(client,indexName);
      await client.query(statement);
    }
    await insertMigration(client,migration);
    return;
  }

  try{
    await client.query("BEGIN");
    await client.query(sql);
    await insertMigration(client,migration);
    await client.query("COMMIT");
  }catch(error){
    await client.query("ROLLBACK");
    throw error;
  }
};
