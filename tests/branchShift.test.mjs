import test from "node:test";
import assert from "node:assert/strict";

const branchShift=await import("../src/lib/branchShift.js").catch(()=>({}));

test("branch register key is stable for every account in the store",()=>{
  assert.equal(typeof branchShift.branchRegisterKey,"function","branch register helper must be available");
  assert.equal(branchShift.branchRegisterKey("store-1"),"store:store-1");
});

test("bootstrap selects the newest open branch shift regardless of cashier",()=>{
  assert.equal(typeof branchShift.selectActiveBranchShifts,"function");
  const shifts=[
    {id:"new",storeId:"store-1",cashierAccountId:"owner",status:"open",openedAtISO:"2026-10-06T12:00:00Z"},
    {id:"old",storeId:"store-1",cashierAccountId:"cashier",status:"open",openedAtISO:"2026-10-06T10:00:00Z"},
    {id:"closed",storeId:"store-1",cashierAccountId:"cashier",status:"closed",openedAtISO:"2026-10-06T13:00:00Z"},
  ];
  assert.equal(branchShift.selectActiveBranchShifts(shifts)["store-1"].id,"new");
});

test("branch-locked active shift selection excludes every other store",()=>{
  const shifts=[
    {id:"mine",storeId:"store-1",status:"open",openedAtISO:"2026-10-06T12:00:00Z"},
    {id:"other",storeId:"store-2",status:"open",openedAtISO:"2026-10-06T13:00:00Z"},
  ];
  assert.deepEqual(Object.keys(branchShift.selectActiveBranchShifts(shifts,{allowedStoreId:"store-1"})),["store-1"]);
});

test("shift open takes a branch advisory lock before checking for an existing shift",async()=>{
  assert.equal(typeof branchShift.findOpenBranchShiftWithLock,"function");
  const calls=[];
  const client={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes("SELECT id FROM shifts"))return {rows:[{id:"already-open"}]};
    return {rows:[]};
  }};
  assert.deepEqual(await branchShift.findOpenBranchShiftWithLock(client,"org-1","store-1"),{id:"already-open"});
  assert.match(calls[0].sql,/pg_advisory_xact_lock/);
  assert.deepEqual(calls[0].args,["org-1:store-1"]);
  assert.match(calls[1].sql,/organization_id=\$1 AND store_id=\$2 AND status='open'/);
});

test("a scoped open shift is usable even when another account opened it",()=>{
  assert.equal(typeof branchShift.assertSharedOpenShift,"function");
  const shift={id:"shift-1",organization_id:"org-1",store_id:"store-1",cashier_id:"owner-1",status:"open"};
  assert.equal(branchShift.assertSharedOpenShift(shift,{organizationId:"org-1",storeId:"store-1",actorId:"cashier-2"}),shift);
  assert.throws(()=>branchShift.assertSharedOpenShift(shift,{organizationId:"org-1",storeId:"store-2",actorId:"cashier-2"}),/Smena ochiq emas/);
});
