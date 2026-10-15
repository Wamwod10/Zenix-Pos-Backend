import test from 'node:test';
import assert from 'node:assert/strict';
import {READ_REPORT_SCHEMAS,readAgentReport} from '../src/services/aiReadReports.js';
import {AGENT_TOOLS} from '../src/services/aiAgentRegistry.js';
const user={id:'seller',organizationId:'tenant',appRole:'OWNER',permissionOverrides:{},rolePermissions:{}};
function database({sale=null,items=[],payments=[]}={}){
 const calls=[];
 return {calls,async query(sql,params){calls.push({sql,params});
  if(sql.includes('FROM organizations'))return {rows:[{timezone:'Asia/Tashkent',settings:{}}]};
  if(sql.includes('FROM stores'))return {rows:[{id:params[0]}]};
  if(sql.includes('FROM sale_items'))return {rows:items};
  if(sql.includes('FROM sale_payments'))return {rows:payments};
  if(sql.includes('FROM sales'))return {rows:sale?[sale]:[]};
  throw new Error('Unexpected query');
 }};
}
test('latest sale is registered and accepts only trusted store selection',()=>{
 assert.ok(AGENT_TOOLS.some(t=>t.name==='get_latest_sale'));
 assert.ok(READ_REPORT_SCHEMAS.get_latest_sale.safeParse({storeId:null}).success);
 assert.equal(READ_REPORT_SCHEMAS.get_latest_sale.safeParse({storeId:null,sellerId:'other'}).success,false);
});
test('latest sale returns explicit no data without inventing a today sale',async()=>{
 const report=await readAgentReport(database(),user,'get_latest_sale',{storeId:null});
 assert.equal(report.topic,'latest_sale');assert.equal(report.sale,null);assert.equal(report.from,null);
 assert.equal(report.facts.find(f=>f.id==='latest_sale_count').value,'0');
});
test('latest sale queries all dates with tenant scope and exposes exact safe item/payment fields',async()=>{
 const db=database({sale:{id:'sale',store_id:'branch',sale_number:'S-1',created_at:'2026-01-01T12:00:00.000Z',business_date:'2026-01-01',total:'12500.25',returned_amount:'0.00',status:'completed'},items:[{product_name:'Rice',unit:'kg',quantity:'1.250',unit_price:'10000.20',line_total:'12500.25',metadata:{secret:'hidden'}}],payments:[{method:'cash',amount:'12500.25',metadata:{card:'hidden'}}]});
 const report=await readAgentReport(db,user,'get_latest_sale',{storeId:null});
 assert.equal(report.from,'2026-01-01');assert.equal(report.sale.total,'12500.25');
 assert.equal(report.selection,'latest');
 assert.equal(report.facts.find(f=>f.id==='latest_sale_payment_0').value,'12500.25');
 assert.match(report.facts.find(f=>f.id==='latest_sale_payment_0').label,/cash/);
 assert.equal(report.facts.find(f=>f.id==='latest_sale_created_at').value,'2026-01-01T12:00:00.000Z');
 assert.deepEqual(report.latestSale,{id:'sale',storeId:'branch',saleNumber:'S-1',businessDate:'2026-01-01'});
 assert.deepEqual(report.sale.items,[{name:'Rice',unit:'kg',quantity:'1.250',unitPrice:'10000.20',lineTotal:'12500.25'}]);
 assert.deepEqual(report.sale.payments,[{method:'cash',amount:'12500.25'}]);
 assert.ok(!JSON.stringify(report).includes('hidden'));
 const query=db.calls.find(c=>c.sql.includes('FROM sales'));
 assert.deepEqual(query.params,['tenant',null,null,null]);assert.match(query.sql,/ORDER BY s.created_at DESC,s.id DESC/);
 assert.doesNotMatch(query.sql,/business_date\s*(?:=|BETWEEN|>=)|CURRENT_DATE/);
});
test('latest sale keeps branch-locked seller scope and rejects other stores',async()=>{
 const seller={...user,appRole:'SALES',storeId:'branch'};const db=database();
 const report=await readAgentReport(db,seller,'get_latest_sale',{storeId:null});
 assert.equal(report.sellerScoped,true);assert.equal(report.storeId,'branch');
 assert.deepEqual(db.calls.find(c=>c.sql.includes('FROM sales')).params,['tenant','branch','seller',null]);
 await assert.rejects(()=>readAgentReport(db,seller,'get_latest_sale',{storeId:'other'}),e=>e.code==='STORE_FORBIDDEN');
});

test('exact sale selection is parameterized within tenant/store/seller scope and inaccessible ids have no data',async()=>{
 const saleId='11111111-1111-4111-8111-111111111111';
 assert.deepEqual(READ_REPORT_SCHEMAS.get_latest_sale.parse({storeId:null}),{storeId:null,saleId:null});
 assert.equal(READ_REPORT_SCHEMAS.get_latest_sale.safeParse({storeId:null,saleId:'bad'}).success,false);
 const db=database();const report=await readAgentReport(db,{...user,appRole:'SALES',storeId:'branch'},'get_latest_sale',{storeId:null,saleId});
 assert.equal(report.sale,null);
 assert.equal(report.selection,'by_id');
 const query=db.calls.find(c=>c.sql.includes('FROM sales'));
 assert.deepEqual(query.params,['tenant','branch','seller',saleId]);
 assert.match(query.sql,/\(\$4::uuid IS NULL OR s.id=\$4\)/);assert.ok(!query.sql.includes(saleId));
});
test('large sale baskets display only 50 items with explicit truncation and preserve full monetary total',async()=>{
 const item={product_name:'Rice',unit:'kg',quantity:'1.000',unit_price:'1.00',line_total:'1.00'};
 const db=database({sale:{id:'sale',created_at:'2020-01-01T00:00:00Z',business_date:'2020-01-01',total:'999999999999.99',returned_amount:'0.00',status:'completed'},items:Array.from({length:51},()=>item)});
 const report=await readAgentReport(db,user,'get_latest_sale',{storeId:null});
 assert.equal(report.sale.items.length,50);assert.equal(report.tables[0].rows.length,50);assert.equal(report.sale.hasMoreItems,true);
 assert.equal(report.sale.total,'999999999999.99');assert.ok(report.notes.some(n=>n.includes('50')));
 assert.match(db.calls.find(c=>c.sql.includes('FROM sale_items')).sql,/LIMIT 51/);
});
