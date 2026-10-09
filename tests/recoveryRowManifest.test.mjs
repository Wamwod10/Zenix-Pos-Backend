import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOVERY_ROW_TABLES,RECOVERY_ROW_SOURCES,RECOVERY_MAX_ROWS_PER_TABLE,recoveryRowManifest,compareRecoveryRowManifests } from '../src/services/tenantRecovery.js';
const ORG='22222222-2222-4222-8222-222222222222';
const digest='a'.repeat(64);
const allTables=()=>Object.fromEntries(RECOVERY_ROW_TABLES.map(t=>[t,{rows:0,fingerprint:digest}]));
const manifest=tables=>({tenantFingerprint:digest,complete:true,tables});
function fakePool(records,{fail=false}={}){
  const calls=[];let released=0;
  return {calls,get released(){return released;},connect:async()=>({query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT id'))return {rows:[{id:ORG}]};
    if(sql.includes('AS fingerprint')){if(fail)throw Error('SECRET receipt and password');return {rows:records};}
    return {rows:[]};
  },release:()=>released++})};
}
test('manifest reads fixed bounded tenant sources and exports no identifiers or raw fields',async()=>{
  const pool=fakePool([{fingerprint:'a'.repeat(64),id:'PRIVATE-ID',receipt:'SECRET'}]);
  const result=await recoveryRowManifest(pool,ORG,{limit:100});
  assert.deepEqual(Object.keys(result.tables.products).sort(),['fingerprint','rows']);
  assert.match(result.tables.products.fingerprint,/^[a-f0-9]{64}$/);assert.equal(result.tables.products.rows,1);
  assert.equal(pool.released,1);assert.equal(pool.calls[0].sql,'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.calls.at(-1).sql,'COMMIT');
  for(const {sql,params} of pool.calls.filter(c=>c.sql.includes('AS fingerprint'))){
    assert.match(sql,/^SELECT /);assert.match(sql,/WHERE .*\$1.*ORDER BY .*LIMIT \$2/s);assert.deepEqual(params,[ORG,101]);
    assert.doesNotMatch(sql,/\b(?:INSERT|DELETE|UPDATE|TRUNCATE|DROP|COPY)\b/i);
  }
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE-ID|SECRET|22222222/);
});
test('fingerprints stay equal after row reordering and detect same-count edits',async()=>{
  const a={fingerprint:'a'.repeat(64)},b={fingerprint:'b'.repeat(64)},c={fingerprint:'c'.repeat(64)};
  const first=await recoveryRowManifest(fakePool([a,b]),ORG);
  const reordered=await recoveryRowManifest(fakePool([b,a]),ORG);assert.deepEqual(first,reordered);
  const edited=await recoveryRowManifest(fakePool([a,c]),ORG);
  assert.notEqual(first.tables.products.fingerprint,edited.tables.products.fingerprint);
  assert.equal(first.tables.products.rows,edited.tables.products.rows);
});
test('row cap and query errors roll back and release without exposing database contents',async()=>{
  const pool=fakePool([{fingerprint:'a'.repeat(64)},{fingerprint:'b'.repeat(64)}]);
  await assert.rejects(()=>recoveryRowManifest(pool,ORG,{limit:1}),/limit exceeded/);
  assert.equal(pool.calls.at(-1).sql,'ROLLBACK');assert.equal(pool.released,1);
  const failed=fakePool([],{fail:true});
  await assert.rejects(()=>recoveryRowManifest(failed,ORG),e=>e.code==='RECOVERY_READ_FAILED'&&!e.message.includes('SECRET'));
  assert.equal(failed.calls.at(-1).sql,'ROLLBACK');assert.equal(failed.released,1);
  await assert.rejects(()=>recoveryRowManifest(pool,ORG,{limit:RECOVERY_MAX_ROWS_PER_TABLE+1}),/Invalid recovery row limit/);
});
test('comparison requires every child and rejects incomplete, mismatched or malformed summaries',()=>{
  for(const table of ['sale_items','sale_payments','supplier_invoice_items','stock_transfer_items','auth_sessions','user_preferences','notification_deliveries','platform_promo_reservations']){
    assert.ok(RECOVERY_ROW_TABLES.includes(table),`missing coverage: ${table}`);
    const before=allTables();delete before[table];
    assert.throws(()=>compareRecoveryRowManifests(manifest(before),manifest(allTables())),/Missing recovery table/);
  }
  assert.throws(()=>compareRecoveryRowManifests({...manifest(allTables()),complete:false},manifest(allTables())),/Incomplete/);
  assert.throws(()=>compareRecoveryRowManifests(manifest(allTables()),{...manifest(allTables()),tenantFingerprint:'b'.repeat(64)}),/mismatch/);
  const bad=allTables();bad.products={rows:0,fingerprint:'PRIVATE ROW'};
  assert.throws(()=>compareRecoveryRowManifests(manifest(bad),manifest(allTables())),/Invalid recovery summary/);
});
test('comparison emits only validated count and fingerprint summaries',()=>{
  const before=allTables(),after=allTables();after.products={rows:0,fingerprint:'b'.repeat(64),id:'PRIVATE ROW',receipt:'SECRET'};
  const result=compareRecoveryRowManifests(manifest(before),manifest(after));
  assert.deepEqual(result.differences,[{table:'products',before:{rows:0,fingerprint:digest},after:{rows:0,fingerprint:'b'.repeat(64)}}]);
  assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE ROW|examples|organizationId/);
});
test('all linked sources use proven tenant parents and immutable allowlist entries',()=>{
  assert.equal(new Set(RECOVERY_ROW_TABLES).size,RECOVERY_ROW_SOURCES.length);
  const parents={sale_items:'sales',sale_payments:'sales',supplier_invoice_items:'supplier_invoices',stock_transfer_items:'stock_transfers',auth_sessions:'users',user_preferences:'users',notification_deliveries:'notification_outbox'};
  for(const source of RECOVERY_ROW_SOURCES){
    assert.ok(Object.isFrozen(source));assert.match(source.table,/^[a-z_]+$/);assert.doesNotMatch(source.where,/;|--|\/\*/);
    if(parents[source.table])assert.match(source.where,new RegExp(`FROM ${parents[source.table]} p WHERE p.id=t.[a-z_]+ AND p.organization_id=\\$1`));
    else assert.match(source.where,source.table==='organizations'?/^t.id=\$1$/:/^t.organization_id=\$1$/);
  }
});
test('recovery pins timestamp serialization and uses SHA-256 row fingerprints',async()=>{
  const pool=fakePool([]);
  await recoveryRowManifest(pool,ORG);
  assert.ok(pool.calls.some(({sql})=>sql==="SET LOCAL TIME ZONE 'UTC'"));
  for(const {sql} of pool.calls.filter(c=>c.sql.includes('AS fingerprint'))){
    assert.match(sql,/sha256\(convert_to\(to_jsonb\(t\)::text, 'UTF8'\)\)/);
    assert.doesNotMatch(sql,/md5/i);
  }
});
