import test from 'node:test';
import assert from 'node:assert/strict';
import {readAgentReport} from '../src/services/aiReadReports.js';
import {aiReport,withAiReportSnapshot} from '../src/services/aiReports.js';

test('shared readers still authorize each topic and untrusted snapshots cannot bypass scope reads',async()=>{
 const user={id:'owner',organizationId:'org',appRole:'OWNER',permissionOverrides:{},rolePermissions:{}},calls=[];
 const db={async query(sql){calls.push(sql);return {rows:[sql.startsWith('SELECT timezone')?{timezone:'Asia/Tashkent',settings:{}}:{amount:'0'}]}}};
 await withAiReportSnapshot(db,user,null,async read=>{
  user.appRole='CASHIER';user.storeId='branch';
  await assert.rejects(()=>read('profit'),e=>e.code==='AI_FORBIDDEN');
 });
 user.appRole='OWNER';user.storeId=null;calls.length=0;
 await aiReport(user,'expenses',null,db,{active:true,db,user,store:null,org:{timezone:'UTC'}});
 assert.equal(calls.filter(sql=>sql.startsWith('SELECT timezone')).length,1);
});
test('overview shares organization snapshot while retaining topic-level permission checks',async()=>{
 const calls=[],user={id:'owner',organizationId:'org',appRole:'OWNER',permissionOverrides:{},rolePermissions:{}};
 const db={async query(sql){calls.push(sql);if(sql.startsWith('SELECT timezone'))return {rows:[{timezone:'Asia/Tashkent',settings:{}}]};if(sql.startsWith('WITH a AS'))return {rows:[]};return {rows:[{count:'0',gross:'0',refunds:'0',amount:'0',catalog:'0',available:'0',low:'0',stores:'0',warehouses:'0'}]}}};
 const report=await readAgentReport(db,user,'get_business_overview',{storeId:null});
 assert.equal(report.topic,'business_overview');
 assert.ok(report.facts.some(f=>f.id==='today_sales_today_net'));
 assert.ok(calls.filter(sql=>sql.startsWith('SELECT timezone')).length<=3,'overview must not reread organization per component');
 assert.equal(calls.filter(sql=>sql.startsWith('SET LOCAL')).length,1);
});
