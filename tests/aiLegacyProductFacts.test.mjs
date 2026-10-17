import test from 'node:test';
import assert from 'node:assert/strict';
import {aiReport} from '../src/services/aiReports.js';
const user={id:'seller',organizationId:'organization',appRole:'OWNER'};
const product={product_id:'product',name:'Quruq salfetka 100 dona',unit:'piece',qty:'2',revenue:'50000',profit:'12000',total:'1'};
function database(rows=[product]){
 const calls=[];
 return {calls,async query(sql,args){calls.push({sql,args});return {rows:sql.startsWith('SELECT timezone')?[{timezone:'Asia/Tashkent',settings:{}}]:sql.startsWith('WITH a AS')?rows:[]}}};
}
test('legacy quantity ranking keeps package name, actual net quantity, unit and revenue',async()=>{
 const db=database();const report=await aiReport(user,'top_products',null,db);
 const money=report.facts.find(f=>f.id==='top_products_0');
 assert.equal(money.productName,product.name);assert.equal(money.productId,'product');
 assert.equal(money.qty,'2');assert.equal(money.quantityUnit,'piece');
 assert.equal(money.value,'50000');assert.equal(money.unit,'UZS');assert.equal(money.metric,'revenue');
 const qty=report.facts.find(f=>f.id==='top_products_0_qty');
 assert.equal(qty.value,'2');assert.equal(qty.unit,'piece');assert.equal(qty.metric,'net_quantity');
 assert.match(money.label,/Quruq salfetka 100 dona/);
 assert.deepEqual(report.tables[0].rows[0],[product.name,'2','piece','50000']);
 const query=db.calls.find(c=>c.sql.startsWith('WITH a AS'));
 assert.match(query.sql,/p\.unit/);assert.match(query.sql,/ORDER BY x\.qty DESC/);
 assert.match(query.sql,/COALESCE\(a\.qty,0\)-COALESCE\(b\.qty,0\)/);
 assert.deepEqual(query.args.slice(0,3),['organization',null,null]);
 assert.equal(query.args[3],report.from);assert.equal(query.args[4],report.to);
});
test('legacy profit preserves unknown historical cost and explicit profit metric',async()=>{
 const db=database([{...product,profit:null}]);const report=await aiReport(user,'profit',null,db);
 const money=report.facts.find(f=>f.id==='profit_0');
 assert.equal(money.productName,product.name);assert.equal(money.value,null);assert.equal(money.metric,'profit');
 assert.equal(report.facts.find(f=>f.id==='profit_0_qty').value,'2');
 const sql=db.calls.find(c=>c.sql.startsWith('WITH a AS')).sql;
 assert.match(sql,/ORDER BY x\.profit DESC NULLS LAST/);assert.match(sql,/CASE WHEN COALESCE\(a\.known,true\) AND COALESCE\(b\.known,true\)/);
});
test('legacy reports still reject unauthorized profit before reading data',async()=>{
 const db=database();await assert.rejects(()=>aiReport({...user,appRole:'CASHIER',storeId:'store'},'profit',null,db),e=>e.code==='AI_FORBIDDEN');
 assert.equal(db.calls.length,0);
});
test('legacy quantity rankings disclose mixed units and keep seller scope',async()=>{
 const db=database([product,{...product,product_id:'rice',name:'Rice',unit:'kg',qty:'1.25'}]);
 const report=await aiReport({...user,appRole:'CASHIER',storeId:'store'},'top_products',null,{
  async query(sql,args){if(sql.startsWith('SELECT id,name,active FROM stores'))return {rows:[{id:'store'}]};return db.query(sql,args)}
 });
 assert.match(report.notes.join(' '),/turli birliklar/);
 assert.equal(report.facts.find(f=>f.id==='top_products_1_qty').value,'1.25');
 assert.equal(report.facts.find(f=>f.id==='top_products_1_qty').unit,'kg');
 assert.deepEqual(db.calls.find(c=>c.sql.startsWith('WITH a AS')).args.slice(0,3),['organization','store','seller']);
 assert.equal(report.sellerScoped,true);
});
