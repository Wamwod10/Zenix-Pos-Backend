import test from 'node:test';import assert from 'node:assert/strict';
import {saleView,salesPage} from '../src/services/salesDirectory.js';
test('today sale includes original refund net amounts and item units',()=>{
 const sale=saleView({id:'sale',total:'100',returned_amount:'25',created_at:'2026-10-09T05:00:00Z',business_date:'2026-10-09',items:[{name:'Apple',quantity:'2',lineTotal:'100',unit:'kg',returnedQty:'0.5'}],payments:[{method:'card',amount:'100'}]});
 assert.equal(sale.originalTotal,100);assert.equal(sale.returnedTotal,25);assert.equal(sale.netTotal,75);assert.equal(sale.returnStatus,'partial_returned');assert.equal(sale.items[0].unit,'kg');
});
test('page queries tenant branch date once and keeps bounded parameters',async()=>{
 let calls=0;
 const page=await salesPage({query:async(sql,params)=>{calls++;assert.deepEqual(params,['tenant','branch','2026-10-09',30,0]);assert.match(sql,/WHERE s.organization_id=\$1 AND s.store_id=\$2/);return {rows:[]}}},{organizationId:'tenant',storeId:'branch',businessDate:'2026-10-09'});
 assert.equal(calls,1);assert.deepEqual(page.items,[]);assert.equal(page.hasMore,false);
});
