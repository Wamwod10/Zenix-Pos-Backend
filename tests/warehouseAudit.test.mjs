import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadMigrationCatalog} from '../src/db/migrationCatalog.js';
const module=await import('../scripts/warehouseAudit.mjs').catch(()=>({}));
const catalog=await loadMigrationCatalog(fileURLToPath(new URL('../migrations/',import.meta.url)));
function database({after=false,upgrade=false,pending=null,violations='0',drift=false,unknown=false}={}){
 const calls=[];
 return {calls,query:async(sql)=>{
  calls.push(sql);
  if(sql.startsWith('SELECT name,'))return {rows:[...catalog.filter(row=>pending?!pending.includes(row.prefix):after||(upgrade?row.prefix!=='032':!['031','032'].includes(row.prefix))).map(row=>({name:row.name,checksum:drift?'wrong':row.checksum})),...(unknown?[{name:'032_unknown.sql',checksum:'unknown'}]:[])]};
  if(sql.includes("AS check_name"))return [{rows:[]},{rows:[{check_name:'partition',violations}]}];
  if(sql.startsWith('SELECT current_database'))return {rows:[{database:'zenix_test'}]};
  return {rows:[]};
 }};
}
test('warehouse preflight uses a read-only session and accepts only 031+032 pending',async()=>{
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
test('warehouse audit rejects invalid phases and refuses after while migrations are pending',async()=>{
 const db=database();await assert.rejects(()=>module.auditWarehouseMigration(db,{phase:'after'}));
 assert.equal(db.calls.at(-1),'ROLLBACK');
 const other=database();await assert.rejects(()=>module.auditWarehouseMigration(other,{phase:'invalid'}));assert.equal(other.calls.length,0);
});


test('warehouse preflight accepts applied 031 with only 032 pending',async()=>{
 const db=database({upgrade:true});const result=await module.auditWarehouseMigration(db,{phase:'before'});
 assert.equal(result.ok,true);assert.ok(db.calls.some(sql=>sql.includes('zero balances with absent warehouse rows')));
});

test('post-032 SQL rejects absent partitions even for zero aggregate quantity',async()=>{
 const {readFile}=await import('node:fs/promises');
 const sql=await readFile(new URL('../scripts/sql/032_warehouse_integrity.sql',import.meta.url),'utf8');
 assert.match(sql,/FULL OUTER JOIN/);assert.match(sql,/aggregate_id IS NULL OR partition_id IS NULL/);
});


test('warehouse preflight rejects every other pending migration set',async()=>{
 for(const pending of [[],['031'],['030','031','032']]) {
  const db=database({pending});await assert.rejects(()=>module.auditWarehouseMigration(db,{phase:'before'}),/Migration catalog failed/);
  assert.equal(db.calls.at(-1),'ROLLBACK');
 }
});
