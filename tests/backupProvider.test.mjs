import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {backupHistory,createBackupProvider} from '../src/services/backupProvider.js';

test('backup metadata is unavailable without configuration and never permits restore',async()=>{
  const result=await backupHistory('11111111-1111-4111-8111-111111111111',{source:{}});
  assert.equal(result.available,false);assert.equal(result.restoreAvailable,false);assert.deepEqual(result.snapshots,[]);
});
test('configured HTTPS adapter only requests read-only scoped metadata and requires credentials',async()=>{
 const organizationId='11111111-1111-4111-8111-111111111111';let called=false;
 assert.throws(()=>createBackupProvider({BACKUP_PROVIDER:'http',BACKUP_API_URL:'https://backup.example/snapshots'}));
 const adapter=createBackupProvider({BACKUP_PROVIDER:'http',BACKUP_API_URL:'https://backup.example/snapshots',BACKUP_API_TOKEN:'unit-test-only'}, {fetchImpl:async(url,options)=>{
  called=true;assert.equal(url.searchParams.get('organizationId'),organizationId);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer unit-test-only');
  return {ok:true,json:async()=>({provider:'Example contract fixture',snapshots:[{id:'point',organizationId,createdAt:'2026-10-10T00:00:00.000Z',status:'AVAILABLE'}]})};
 }});
 const history=await backupHistory(organizationId,{adapter});assert.equal(called,true);assert.equal(history.restoreAvailable,false);assert.equal(history.snapshots.length,1);
});
test('configured read-only provider metadata is scoped and invalid provider data fails closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zenix-backup-'));
  try{
    const file=join(dir,'metadata.json'),organizationId='11111111-1111-4111-8111-111111111111';
    await writeFile(file,JSON.stringify({provider:'Operator backup export',snapshots:[
      {id:'own',organizationId,createdAt:'2026-10-10T00:00:00.000Z',status:'AVAILABLE'},
      {id:'other',organizationId:'22222222-2222-4222-8222-222222222222',createdAt:'2026-10-10T00:00:00.000Z',status:'AVAILABLE'},
    ]}));
    const options={source:{BACKUP_PROVIDER:'manifest',BACKUP_MANIFEST_PATH:file}};
    const result=await backupHistory(organizationId,options);
    assert.equal(result.available,true);assert.equal(result.restoreAvailable,false);assert.deepEqual(result.snapshots.map(row=>row.id),['own']);
    await writeFile(file,'invalid metadata');
    const invalid=await backupHistory(organizationId,options);assert.equal(invalid.available,false);assert.equal(invalid.restoreAvailable,false);assert.ok(!invalid.reason.includes(dir));
  }finally{await rm(dir,{recursive:true,force:true})}
});
