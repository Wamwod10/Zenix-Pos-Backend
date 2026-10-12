import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {assertDisposableNeonBranch,assertNeonEndpointUri,assertWarehouseAuditDatabaseUrl} from '../scripts/neonWarehouseAudit.mjs';

test('Neon audit branch verification rejects default, protected and mismatched identities',()=>{
  const identity={id:'br-audit-example',name:'warehouse-audit-test-'+'a'.repeat(24)};
  const branch={...identity,default:false,protected:false,parent_id:'br-parent-example'};
  assert.doesNotThrow(()=>assertDisposableNeonBranch(branch,identity));
  for(const change of [{default:true},{default:undefined},{protected:true},{protected:undefined},{id:'br-other'},{name:'production'},{parent_id:null}]){
    assert.throws(()=>assertDisposableNeonBranch({...branch,...change},identity),/verification failed/);
  }
  assert.throws(()=>assertDisposableNeonBranch({...branch,name:'warehouse-audit-test-short'},{...identity,name:'warehouse-audit-test-short'}),/verification failed/);
});

test('Neon audit URI requires the verified direct endpoint, database, owner and SSL',()=>{
  const endpoint={host:'ep-audit-example.neon.tech'};
  const database={name:'neondb',owner_name:'audit_owner'};
  const value='postgresql://audit_owner:fake-password@ep-audit-example.neon.tech/neondb?sslmode=require';
  assert.equal(assertNeonEndpointUri(value,endpoint,database).hostname,endpoint.host);
  for(const changed of [
    value.replace('ep-audit-example.neon.tech','ep-other.neon.tech'),
    value.replace('ep-audit-example.neon.tech','ep-audit-example-pooler.neon.tech'),
    value.replace('/neondb?','/otherdb?'),value.replace('audit_owner:','other_owner:'),
    value.replace('postgresql:','https:'),value.replace('.neon.tech/','.neon.tech:6543/'),
    value.replace('sslmode=require','sslmode=disable'),value.split('?')[0],
    value+'&host=ep-live.neon.tech',value+'&hostaddr=127.0.0.1',value+'&dbname=live',value+'&pooled=true',
  ])assert.throws(()=>assertNeonEndpointUri(changed,endpoint,database),/mismatch|Unsafe/);
  assert.throws(()=>assertNeonEndpointUri(value,{host:'db.example.com'},database),/mismatch/);
});

test('Neon audit gate retains local-only fallback and cannot be enabled by a remote URL',()=>{
  const local='postgresql://postgres:fake@127.0.0.1:5432/warehouse_audit_test_'+'a'.repeat(24);
  assert.equal(assertWarehouseAuditDatabaseUrl(local,{nodeEnv:'test'}).hostname,'127.0.0.1');
  const neon=local.replace('127.0.0.1','ep-any.neon.tech');
  assert.throws(()=>assertWarehouseAuditDatabaseUrl(neon,{nodeEnv:'test'}),/Neon/);
  assert.throws(()=>assertSafeTestDatabaseUrl(neon,{nodeEnv:'test'}),/Neon/);
  assert.throws(()=>assertWarehouseAuditDatabaseUrl(local,{nodeEnv:'production'}),/production/);
  assert.throws(()=>assertWarehouseAuditDatabaseUrl(local+'?host=ep-live.neon.tech',{nodeEnv:'test'}),/override/);
});
