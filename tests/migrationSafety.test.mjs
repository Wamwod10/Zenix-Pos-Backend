import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const catalogModule=await import("../src/db/migrationCatalog.js").catch(()=>({}));
const runnerModule=await import("../src/db/migrationRunner.js").catch(()=>({}));

async function withMigrationDir(files,work){
  const directory=await mkdtemp(path.join(tmpdir(),"zenix-migrations-"));
  try{
    await Promise.all(Object.entries(files).map(([name,sql])=>writeFile(path.join(directory,name),sql,"utf8")));
    return await work(directory);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
}

function fakePool(handler){
  const calls=[];
  let releases=0;
  const releaseErrors=[];
  const client={
    query:async(sql,params)=>{
      const normalized=String(sql).replace(/\s+/g," ").trim();
      calls.push([normalized,params]);
      return handler?.(normalized,params,calls)??{rows:[],rowCount:0};
    },
    release:(error)=>{releases+=1;releaseErrors.push(error)},
  };
  return {pool:{connect:async()=>client},calls,releaseErrors,get releases(){return releases}};
}

test("migration catalog rejects malformed and duplicate numeric prefixes", async () => {
  assert.equal(typeof catalogModule.loadMigrationCatalog,"function");
  await withMigrationDir({"bad-name.sql":"SELECT 1;"},async(directory)=>{
    await assert.rejects(catalogModule.loadMigrationCatalog(directory),/Invalid migration filename/);
  });
  await withMigrationDir({"001_first.sql":"SELECT 1;","001_second.sql":"SELECT 2;"},async(directory)=>{
    await assert.rejects(catalogModule.loadMigrationCatalog(directory),/Duplicate migration prefix 001/);
  });
});

test("migration catalog returns stable checksums and explicit transaction mode", async () => {
  assert.equal(typeof catalogModule.loadMigrationCatalog,"function");
  await withMigrationDir({
    "002_concurrent.sql":"-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS sample_idx ON sample(id);\n",
    "001_initial.sql":"SELECT 1;\n",
  },async(directory)=>{
    const catalog=await catalogModule.loadMigrationCatalog(directory);
    assert.deepEqual(catalog.map(({name,prefix,transactional})=>({name,prefix,transactional})),[
      {name:"001_initial.sql",prefix:"001",transactional:true},
      {name:"002_concurrent.sql",prefix:"002",transactional:false},
    ]);
    assert.equal(catalog[0].checksum,"b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd");
  });
});

test("migration runner locks before reading state and unlocks after applying", async () => {
  assert.equal(typeof runnerModule.runMigrations,"function");
  await withMigrationDir({"001_initial.sql":"CREATE TABLE example(id uuid);\n"},async(directory)=>{
    const db=fakePool((sql)=>sql.startsWith("SELECT name,checksum")?{rows:[],rowCount:0}:{rows:[],rowCount:1});
    const result=await runnerModule.runMigrations({pool:db.pool,directory,logger:{log(){}}});
    const statements=db.calls.map(([sql])=>sql);
    const lockIndex=statements.findIndex((sql)=>sql.startsWith("SELECT pg_try_advisory_lock"));
    const stateIndex=statements.findIndex((sql)=>sql.startsWith("SELECT name,checksum"));
    assert.ok(lockIndex>=0&&lockIndex<stateIndex);
    assert.ok(statements.includes("BEGIN"));
    assert.ok(statements.some((sql)=>sql.startsWith("INSERT INTO schema_migrations(name,checksum)")));
    assert.ok(statements.at(-1).startsWith("SELECT pg_advisory_unlock"));
    assert.equal(db.releases,1);
    assert.deepEqual(result.applied,["001_initial.sql"]);
  });
});

test("migration runner rejects checksum drift and still unlocks and releases", async () => {
  assert.equal(typeof runnerModule.runMigrations,"function");
  await withMigrationDir({"001_initial.sql":"SELECT 1;\n"},async(directory)=>{
    const db=fakePool((sql)=>sql.startsWith("SELECT name,checksum")?{rows:[{name:"001_initial.sql",checksum:"wrong"}],rowCount:1}:{rows:[],rowCount:1});
    await assert.rejects(runnerModule.runMigrations({pool:db.pool,directory,logger:{log(){}}}),/checksum mismatch.*001_initial\.sql/i);
    assert.ok(db.calls.at(-1)[0].startsWith("SELECT pg_advisory_unlock"));
    assert.equal(db.releases,1);
    assert.ok(!db.calls.some(([sql])=>sql==="BEGIN"));
  });
});

test("migration runner adopts a legacy null checksum without reapplying", async () => {
  assert.equal(typeof runnerModule.runMigrations,"function");
  await withMigrationDir({"001_initial.sql":"SELECT 1;\n"},async(directory)=>{
    const db=fakePool((sql)=>sql.startsWith("SELECT name,checksum")?{rows:[{name:"001_initial.sql",checksum:null}],rowCount:1}:{rows:[],rowCount:1});
    const result=await runnerModule.runMigrations({pool:db.pool,directory,logger:{log(){}}});
    assert.ok(db.calls.some(([sql,params])=>sql.startsWith("UPDATE schema_migrations SET checksum")&&params[0]==="001_initial.sql"));
    assert.ok(!db.calls.some(([sql])=>sql==="BEGIN"));
    assert.deepEqual(result.adopted,["001_initial.sql"]);
  });
});

test("migration unlock failure evicts the client without hiding the primary error", async () => {
  await withMigrationDir({"001_initial.sql":"SELECT 1;\n"},async(directory)=>{
    const db=fakePool((sql)=>{
      if(sql.startsWith("SELECT name,checksum"))return {rows:[{name:"001_initial.sql",checksum:"wrong"}]};
      if(sql.startsWith("SELECT pg_advisory_unlock"))throw new Error("unlock failed");
      return {rows:[],rowCount:1};
    });
    await assert.rejects(runnerModule.runMigrations({pool:db.pool,directory,logger:{log(){}}}),error=>{
      assert.match(error.message,/checksum mismatch/i);
      assert.match(error.unlockError?.message||"",/unlock failed/);
      return true;
    });
    assert.match(db.releaseErrors[0]?.message||"",/unlock failed/);
  });
});

test("migration status is read-only and reports missing migrations", async () => {
  assert.equal(typeof runnerModule.checkMigrationStatus,"function");
  await withMigrationDir({"001_initial.sql":"SELECT 1;\n"},async(directory)=>{
    const calls=[];
    const db={query:async(sql)=>{calls.push(String(sql));return {rows:[],rowCount:0}}};
    const result=await runnerModule.checkMigrationStatus({db,directory});
    assert.deepEqual(result.missing,["001_initial.sql"]);
    assert.deepEqual(result.drifted,[]);
    assert.ok(calls.every((sql)=>/^\s*SELECT/i.test(sql)));
  });
});
