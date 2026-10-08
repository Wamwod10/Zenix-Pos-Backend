import test from "node:test";
import assert from "node:assert/strict";

const migrationModule=await import("../src/db/migrationExecution.js").catch(()=>({}));

test("non-transactional migrations run concurrent indexes outside BEGIN", async () => {
  assert.equal(typeof migrationModule.executeMigration,"function");
  const queries=[];
  const client={query:async(sql,params)=>{queries.push([sql,params]);return {rowCount:1}}};
  const sql=`-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS first_idx ON first_table(id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS second_idx ON second_table(id);`;

  await migrationModule.executeMigration(client,"011_indexes.sql",sql);

  const executed=queries.map(([query])=>query);
  assert.ok(!executed.includes("BEGIN"));
  assert.deepEqual(executed.filter((query)=>query.startsWith("CREATE")||query.startsWith("INSERT")),[
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS first_idx ON first_table(id)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS second_idx ON second_table(id)",
    "INSERT INTO schema_migrations(name) VALUES($1)",
  ]);
  assert.deepEqual(queries.at(-1)[1],["011_indexes.sql"]);
});

test("ordinary migrations remain atomic", async () => {
  assert.equal(typeof migrationModule.executeMigration,"function");
  const queries=[];
  const client={query:async(sql,params)=>{queries.push([sql,params]);return {rowCount:1}}};

  await migrationModule.executeMigration(client,"001_initial.sql","CREATE TABLE example(id uuid);");

  assert.deepEqual(queries.map(([query])=>query),[
    "BEGIN",
    "CREATE TABLE example(id uuid);",
    "INSERT INTO schema_migrations(name) VALUES($1)",
    "COMMIT",
  ]);
});

test("failed ordinary migrations roll back", async () => {
  assert.equal(typeof migrationModule.executeMigration,"function");
  const queries=[];
  const client={query:async(sql)=>{queries.push(sql);if(sql.startsWith("CREATE"))throw new Error("boom")}};

  await assert.rejects(
    migrationModule.executeMigration(client,"broken.sql","CREATE TABLE broken(id uuid);"),
    /boom/,
  );
  assert.deepEqual(queries,["BEGIN","CREATE TABLE broken(id uuid);","ROLLBACK"]);
});

test("concurrent migration retries remove an invalid index before rebuilding it", async () => {
  assert.equal(typeof migrationModule.executeMigration,"function");
  const queries=[];
  const client={query:async(sql,params)=>{
    queries.push([sql,params]);
    if(sql.includes("indisvalid"))return {rows:[{is_valid:false}]};
    return {rows:[],rowCount:1};
  }};

  await migrationModule.executeMigration(
    client,
    "011_indexes.sql",
    "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS first_idx ON first_table(id);",
  );

  assert.ok(queries.some(([sql,params])=>sql.includes("indisvalid")&&params[0]==="first_idx"));
  assert.ok(queries.some(([sql])=>sql==='DROP INDEX CONCURRENTLY IF EXISTS "first_idx"'));
  assert.ok(queries.some(([sql])=>sql.startsWith("CREATE INDEX CONCURRENTLY")));
});
