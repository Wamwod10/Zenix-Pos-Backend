import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackupProvider,backupHistory,recoveryPreview,backupPage,backupPageSchema} from '../src/services/backupProvider.js';
const org='11111111-1111-4111-8111-111111111111';
const source={BACKUP_PROVIDER:'neon',NEON_API_TOKEN:'contract-test-only',NEON_PROJECT_ID:'test-project',NEON_BRANCH_ID:'br-test'};
const fixture={id:'snap-test',name:'Checkpoint',source_branch_id:'br-test',created_at:'2026-10-10T01:00:00Z',timestamp:'2026-10-10T00:59:00Z',lsn:'0/3000000',full_size:1234};
test('Neon adapter uses official read-only API, validates branch and preserves database scope',async()=>{
 const calls=[];const adapter=createBackupProvider(source,{fetchImpl:async(url,options)=>{
  calls.push(String(url));assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
  return {ok:true,json:async()=>String(url).endsWith('/snapshots')?{snapshots:[fixture,{...fixture,id:'snap-other',source_branch_id:'br-other'}]}:{project:{id:'test-project',history_retention_seconds:86400}}};
 }});
 const result=await backupHistory(org,{adapter});
 assert.equal(result.available,true);assert.equal(result.scope,'DATABASE');assert.equal(result.snapshots.length,1);assert.equal(result.snapshots[0].status,'UNKNOWN');
 assert.equal(result.snapshots[0].recoveryPoint,fixture.timestamp);assert.equal(result.pitr.retentionSeconds,86400);assert.equal(result.restoreAvailable,false);assert.equal(calls.length,2);
 const preview=recoveryPreview(org,result,'snap-test');assert.equal(preview.scope,'DATABASE');assert.equal(preview.restoreAvailable,false);assert.equal(preview.diffComputed,false);assert.ok(preview.conflicts.includes('DATABASE_SNAPSHOT_CANNOT_REPLACE_ONE_TENANT'));
 assert.throws(()=>recoveryPreview(org,result,'unknown'),{code:'RECOVERY_SNAPSHOT_NOT_FOUND'});
});
test('Neon config, auth failure and invalid metadata fail closed without revealing credentials',async()=>{
 assert.throws(()=>createBackupProvider({...source,NEON_BRANCH_ID:''}));
 for(const response of [{ok:false,status:401},{ok:true,json:async()=>({snapshots:[{...fixture,created_at:'bad'}]})}]){
  const result=await backupHistory(org,{adapter:createBackupProvider(source,{fetchImpl:async()=>response})});
  assert.equal(result.available,false);assert.equal(result.restoreAvailable,false);assert.ok(!JSON.stringify(result).includes(source.NEON_API_TOKEN));
 }
});
test('legacy tenant metadata never permits cross-tenant recovery preview',()=>{
 const history={available:true,snapshots:[{id:'other',organizationId:'22222222-2222-4222-8222-222222222222',scope:'TENANT',status:'AVAILABLE'}]};
 assert.throws(()=>recoveryPreview(org,history,'other'),{code:'RECOVERY_TENANT_MISMATCH'});
});
test('backup pages are bounded and unknown readiness cannot imply successful backup',()=>{
 const history={available:true,snapshots:Array.from({length:25},(_,i)=>({id:String(i),status:'UNKNOWN'}))};
 const first=backupPage(history,backupPageSchema.parse({}));assert.equal(first.snapshots.length,20);assert.equal(first.hasMore,true);assert.equal(first.total,25);assert.equal(first.lastSuccessfulBackupAt,null);
 assert.equal(backupPage(history,{limit:20,offset:20}).snapshots.length,5);
 for(const input of [{limit:0},{limit:101},{offset:-1},{offset:1.5},{unexpected:'x'}])assert.equal(backupPageSchema.safeParse(input).success,false);
});
