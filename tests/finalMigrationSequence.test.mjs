import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';import {finalMigrationPreflight} from '../scripts/finalMigrationPreflight.mjs';import {runMigrations,checkMigrationStatus} from '../src/db/migrationRunner.js';import {verifyDatabaseSchema} from '../src/db/verifySchema.js';
const url=process.env.MIGRATION_SEQUENCE_TEST_URL;
(url?test:test.skip)('001-024 then read-only preflight and sequential 025-029 converge without drift',{timeout:120000},async()=>{
 assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});const pool=new pg.Pool({connectionString:url});const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zenix-final-migrations-'));const source=path.resolve('migrations');
 try{
  assert.equal((await pool.query("SELECT count(*) count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count,'0','Only an empty separately created test database is permitted');
  const files=(await fs.readdir(source)).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
  for(const file of files.filter(f=>Number(f.slice(0,3))<=24))await fs.copyFile(path.join(source,file),path.join(directory,file));
  await runMigrations({pool,directory});
  for(const version of [25,26,27,28,29]){
   const client=await pool.connect();try{const preflight=await finalMigrationPreflight(client);assert.equal(preflight.ok,true);console.log(`preflight ${version}: duplicates=${JSON.stringify(preflight.duplicateGroups)} unvalidated=${preflight.unvalidatedConstraints.map(c=>c.conname).join(',')}`)}finally{client.release()}
   const file=files.find(f=>Number(f.slice(0,3))===version);await fs.copyFile(path.join(source,file),path.join(directory,file));const result=await runMigrations({pool,directory});assert.deepEqual(result.applied,[file]);
  }
  assert.deepEqual(await checkMigrationStatus({db:pool,directory:source}),{tableMissing:false,missing:[],drifted:[],unverified:[],unknown:[]});await verifyDatabaseSchema(pool);assert.equal((await runMigrations({pool,directory})).applied.length,0);
 }finally{await pool.end();await fs.rm(directory,{recursive:true,force:true})}
});
