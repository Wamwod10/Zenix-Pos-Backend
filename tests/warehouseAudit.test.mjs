import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadMigrationCatalog} from '../src/db/migrationCatalog.js';
const module=await import('../scripts/warehouseAudit.mjs').catch(()=>({}));
const catalog=await loadMigrationCatalog(fileURLToPath(new URL('../migrations/',import.meta.url)));
function database({after=false,violations='0',drift=false,unknown=false}={}){
 const calls=[];
 return {calls,query:async(sql)=>{
  calls.push(sql);
  if(sql.startsWith('SELECT name,'))return {rows:[...catalog.filter(row=>after||row.prefix!=='031').map(row=>({name:row.name,checksum:drift?'wrong':row.checksum})),...(unknown?[{name:'032_unknown.sql',checksum:'unknown'}]:[])]};
  if(sql.includes("AS check_name"))return [{rows:[]},{rows:[{check_name:'partition',violations}]}];
  if(sql.startsWith('SELECT current_database'))return {rows:[{database:'zenix_test'}]};
  return {rows:[]};
 }};
}
test('warehouse preflight uses a read-only session and accepts only 031 pending',async()=>{
 assert.equal(typeof module.auditWarehouseMigration,'function');
 const db=database();const result=await module.auditWarehouseMigration(db,{phase:'before'});
 assert.equal(result.ok,true);assert.match(db.calls[0],/READ ONLY/);assert.equal(db.calls.at(-1),'COMMIT');
});
test('warehouse preflight fails closed on checksum drift, unknown records and nonzero counts',async()=>{
 for(const options of [{drift:true},{unknown:true},{violations:'1'}]){
  const db=database(options);await assert.rejects(()=>module.auditWarehouseMigration(db,{phase:'before'}));
  assert.equal(db.calls.at(-1),'ROLLBACK');
 }
});
test('warehouse audit rejects invalid phases and refuses after while 031 is pending',async()=>{
 const db=database();await assert.rejects(()=>module.auditWarehouseMigration(db,{phase:'after'}));
 assert.equal(db.calls.at(-1),'ROLLBACK');
 const other=database();await assert.rejects(()=>module.auditWarehouseMigration(other,{phase:'invalid'}));assert.equal(other.calls.length,0);
});
