import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const revisionModule=await import("../src/lib/workspaceRevision.js").catch(()=>({}));
const middlewareModule=await import("../src/middleware/workspaceRevision.js").catch(()=>({}));

test("only successful organization mutations bump the workspace revision",()=>{
  assert.equal(typeof revisionModule.shouldBumpWorkspaceRevision,"function","revision policy must be available");
  for(const method of ["POST","PATCH","PUT","DELETE"]){
    assert.equal(revisionModule.shouldBumpWorkspaceRevision({method,statusCode:204,organizationId:"org-1"}),true);
  }
  assert.equal(revisionModule.shouldBumpWorkspaceRevision({method:"GET",statusCode:200,organizationId:"org-1"}),false);
  assert.equal(revisionModule.shouldBumpWorkspaceRevision({method:"POST",statusCode:400,organizationId:"org-1"}),false);
  assert.equal(revisionModule.shouldBumpWorkspaceRevision({method:"POST",statusCode:201,organizationId:null}),false);
});

test("revision reads and bumps stay tenant scoped",async()=>{
  assert.equal(typeof revisionModule.bumpWorkspaceRevision,"function");
  assert.equal(typeof revisionModule.readWorkspaceRevision,"function");
  const calls=[];
  const db={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes("INSERT INTO workspace_revisions"))return {rows:[{revision:"8",updated_at:new Date("2026-10-06T12:00:00.000Z")}]};
    return {rows:[{revision:"7",updated_at:new Date("2026-10-06T11:59:59.000Z")}]};
  }};
  assert.deepEqual(await revisionModule.readWorkspaceRevision(db,"org-a"),{revision:7,updatedAt:"2026-10-06T11:59:59.000Z"});
  assert.deepEqual(await revisionModule.bumpWorkspaceRevision(db,"org-b"),{revision:8,updatedAt:"2026-10-06T12:00:00.000Z"});
  assert.deepEqual(calls.map((call)=>call.args),[["org-a"],["org-b"]]);
});

test("revision middleware reports bump failures after preserving the sent response",async()=>{
  assert.equal(typeof middlewareModule.createWorkspaceRevisionMiddleware,"function");
  const errors=[];
  const response=new EventEmitter();response.statusCode=201;
  const middleware=middlewareModule.createWorkspaceRevisionMiddleware({
    bump:async()=>{throw new Error("revision unavailable")},
    logger:{error:(...args)=>errors.push(args)},
  });
  let nextCalled=false;
  middleware({method:"POST",user:{organizationId:"org-1"}},response,()=>{nextCalled=true});
  assert.equal(nextCalled,true);
  response.emit("finish");
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(response.statusCode,201);
  assert.equal(errors.length,1);
  assert.match(String(errors[0][0]),/workspace revision/i);
});
