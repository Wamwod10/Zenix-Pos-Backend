import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MIGRATION_NAME=/^(\d{3})_[a-z0-9_]+\.sql$/;
const NO_TRANSACTION_DIRECTIVE="-- migrate:no-transaction";

const normalizeSql=(value)=>String(value).replace(/\r\n/g,"\n");
const checksumSql=(sql)=>createHash("sha256").update(sql,"utf8").digest("hex");

export async function loadMigrationCatalog(directory){
  const names=(await fs.readdir(directory)).filter((name)=>name.endsWith(".sql")).sort();
  const prefixes=new Set();
  const catalog=[];
  for(const name of names){
    const match=name.match(MIGRATION_NAME);
    if(!match)throw new Error(`Invalid migration filename: ${name}`);
    const prefix=match[1];
    if(prefixes.has(prefix))throw new Error(`Duplicate migration prefix ${prefix}`);
    prefixes.add(prefix);
    const sql=normalizeSql(await fs.readFile(path.join(directory,name),"utf8"));
    catalog.push({name,prefix,sql,checksum:checksumSql(sql),transactional:!sql.trimStart().startsWith(NO_TRANSACTION_DIRECTIVE)});
  }
  return catalog;
}
