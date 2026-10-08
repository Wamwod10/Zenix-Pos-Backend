import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";
import { checkMigrationStatus } from "./migrationRunner.js";

const here=path.dirname(fileURLToPath(import.meta.url));
const migrationDir=path.resolve(here,"../../migrations");
try{
  const status=await checkMigrationStatus({db:pool,directory:migrationDir});
  const ok=!status.tableMissing&&!status.missing.length&&!status.drifted.length&&!status.unverified.length;
  console.log(JSON.stringify({ok,...status},null,2));
  if(!ok)process.exitCode=1;
}finally{
  await pool.end().catch(()=>{});
}
