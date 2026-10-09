import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { recoverySnapshot, compareRecoverySnapshots, RECOVERY_ROW_TABLES } from '../src/services/tenantRecovery.js';
const ORG='22222222-2222-4222-8222-222222222222';
const fp='a'.repeat(64);
const metrics=()=>Object.fromEntries(RECOVERY_ROW_TABLES.map(table=>[table,{rows:0,fingerprint:fp}]));

test('snapshot exposes only counts and fingerprints, with bounded scoped reads',async()=>{
  const calls=[];let released=0;
  const pool={connect:async()=>({query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.startsWith('SELECT id'))return {rows:[{id:ORG,name:'PRIVATE ORGANIZATION'}]};
    if(sql.includes('AS fingerprint'))return {rows:[{fingerprint:'a'.repeat(32),id:'PRIVATE ROW',name:'PRIVATE PERSON'}]};
    if(sql.includes('AS negative_balances'))return {rows:[{negative_balances:0,invalid_returns:0}]};
    if(sql.includes('count(*)'))return {rows:[{rows:'1',amount:'12'}]};
    return {rows:[]};
  },release:()=>released++})};
  const result=await recoverySnapshot(pool,ORG);
  assert.equal(released,1);
  assert.deepEqual(Object.keys(result.metrics.products).sort(),['fingerprint','rows']);
  assert.equal(result.metrics.products.rows,1);
  for(const secret of [ORG,'PRIVATE ORGANIZATION','PRIVATE PERSON','PRIVATE ROW','amount'])assert.ok(!JSON.stringify(result).includes(secret));
  for(const {sql,params} of calls.filter(c=>c.sql.startsWith('SELECT'))){
    assert.match(sql,/\$1/);assert.equal(params[0],ORG);
    assert.match(sql,sql.includes('AS fingerprint')?/LIMIT \$2/:/LIMIT 1/);
    assert.doesNotMatch(sql,/\b(?:INSERT|DELETE|UPDATE|TRUNCATE|DROP|COPY)\b/i);
  }
});
test('aggregate comparison fails closed on missing tables and never reflects extra values',()=>{
  const before=metrics(),after=metrics();after.products={rows:1,fingerprint:'b'.repeat(64),name:'PRIVATE'};
  const result=compareRecoverySnapshots({tenantFingerprint:fp,metrics:before},{tenantFingerprint:fp,metrics:after});
  assert.deepEqual(result.changedTables,['products']);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  delete before.sale_items;
  assert.throws(()=>compareRecoverySnapshots({tenantFingerprint:fp,metrics:before},{tenantFingerprint:fp,metrics:after}),/Missing recovery table/);
});
test('invalid organization is rejected before DB access',async()=>{
  await assert.rejects(()=>recoverySnapshot({connect:()=>{throw Error('Unexpected connection');}},'0;DROP TABLE sales'),/Valid organization/);
});
test('CLI rejects production and unsafe targets without exposing secrets or connecting',()=>{
  const valid='postgres://user:SECRET_PASSWORD@127.0.0.1:5432/recovery_test_source';
  for(const [source,nodeEnv] of [
    ['postgres://user:SECRET_PASSWORD@prod.neon.tech/test_source','test'],
    ['postgres://user:SECRET_PASSWORD@127.0.0.1/production_test','test'],
    [valid+'?host=prod.neon.tech','test'],[valid+'?options=-c%20default_transaction_read_only%3Doff','test'],
    [valid,'production'],['not-a-url-SECRET_PASSWORD','test'],
    ['postgres://user:SECRET_PASSWORD@localhost:5432/recovery_test_target','test'],
  ]){
    const result=spawnSync(process.execPath,['scripts/compareTenantRecovery.mjs',ORG],{
      cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:4000,
      env:{...process.env,NODE_ENV:nodeEnv,RECOVERY_SOURCE_DATABASE_URL:source,
        RECOVERY_TARGET_DATABASE_URL:'postgres://user:SECRET_PASSWORD@127.0.0.1:5432/recovery_test_target'},
    });
    assert.equal(result.status,2,`unsafe target must fail before connection: ${result.stderr}`);
    assert.doesNotMatch(result.stdout+result.stderr,/SECRET_PASSWORD|postgres:\/\/|prod\.neon\.tech|ECONNREFUSED/);
  }
});
