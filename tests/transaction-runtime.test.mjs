import test from "node:test";
import assert from "node:assert/strict";

const txModule=await import("../src/db/tx.js").catch(()=>({}));

function fakeDb({failOn}={}){
  const queries=[];
  let releases=0;
  const releaseErrors=[];
  const client={
    query:async(sql)=>{
      queries.push(sql);
      if(failOn?.(sql))throw new Error(`failed:${sql}`);
      return {rows:[],rowCount:0};
    },
    release:(error)=>{releases+=1;releaseErrors.push(error)},
  };
  return {db:{connect:async()=>client},client,queries,releaseErrors,get releases(){return releases}};
}

test("runTransaction commits a successful unit and releases its client", async () => {
  assert.equal(typeof txModule.runTransaction,"function");
  const state=fakeDb();
  const result=await txModule.runTransaction(state.db,async(client)=>{
    await client.query("SELECT work");
    return "saved";
  });
  assert.equal(result,"saved");
  assert.deepEqual(state.queries,["BEGIN","SELECT work","COMMIT"]);
  assert.equal(state.releases,1);
  assert.equal(state.releaseErrors[0],undefined);
});

test("runTransaction rolls back the original work failure and releases", async () => {
  assert.equal(typeof txModule.runTransaction,"function");
  const state=fakeDb();
  const original=new Error("business failure");
  await assert.rejects(txModule.runTransaction(state.db,async()=>{throw original}),error=>error===original);
  assert.deepEqual(state.queries,["BEGIN","ROLLBACK"]);
  assert.equal(state.releases,1);
  assert.equal(state.releaseErrors[0],undefined);
});

test("BEGIN and COMMIT failures evict the uncertain client", async () => {
  for(const statement of ["BEGIN","COMMIT"]){
    const state=fakeDb({failOn:(sql)=>sql===statement});
    await assert.rejects(txModule.runTransaction(state.db,async()=>"ok"),new RegExp(`failed:${statement}`));
    assert.match(state.releaseErrors[0]?.message||"",new RegExp(`failed:${statement}`));
  }
});

test("rollback failure is attached without hiding the original failure", async () => {
  assert.equal(typeof txModule.runTransaction,"function");
  const state=fakeDb({failOn:(sql)=>sql==="ROLLBACK"});
  const original=new Error("business failure");
  await assert.rejects(txModule.runTransaction(state.db,async()=>{throw original}),error=>{
    assert.equal(error,original);
    assert.match(error.rollbackError?.message||"",/failed:ROLLBACK/);
    return true;
  });
  assert.equal(state.releases,1);
  assert.match(state.releaseErrors[0]?.message||"",/failed:ROLLBACK/);
});

test("runTransaction supports only explicit PostgreSQL isolation levels", async () => {
  assert.equal(typeof txModule.runTransaction,"function");
  const state=fakeDb();
  await txModule.runTransaction(state.db,async()=>"ok",{isolationLevel:"serializable"});
  assert.equal(state.queries[0],"BEGIN ISOLATION LEVEL SERIALIZABLE");
  await assert.rejects(txModule.runTransaction(state.db,async()=>"bad",{isolationLevel:"unsafe value"}),/Unsupported transaction isolation level/);
  assert.equal(state.releases,1);
});

test("password and session revocation routes use the common transaction boundary", async () => {
  const source=await import("node:fs/promises").then(({readFile})=>readFile(new URL("../src/routes/users.js",import.meta.url),"utf8"));
  const reset=source.match(/router\.post\("\/:id\/reset-password"[\s\S]*?\n\}\)\);/i)?.[0]||"";
  const change=source.match(/router\.post\("\/me\/password"[\s\S]*?\n\}\)\);/i)?.[0]||"";
  assert.match(reset,/withTransaction/);
  assert.match(change,/withTransaction/);
  assert.doesNotMatch(reset,/await pool\.query/);
  assert.doesNotMatch(change,/await pool\.query/);
});
