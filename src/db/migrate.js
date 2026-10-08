import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrationPool } from "./migrationPool.js";
import { runMigrations } from "./migrationRunner.js";

const here=path.dirname(fileURLToPath(import.meta.url));
const migrationDir=path.resolve(here,"../../migrations");
try{
  await runMigrations({pool:migrationPool,directory:migrationDir});
}finally{
  await migrationPool.end().catch(()=>{});
}
