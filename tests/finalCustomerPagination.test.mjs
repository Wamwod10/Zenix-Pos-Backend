import test from 'node:test';
import assert from 'node:assert/strict';
import * as directory from '../src/services/customerDirectory.js';
const organizationId='11111111-1111-4111-8111-111111111111';
const customerId='22222222-2222-4222-8222-222222222222';
test('customer history strictly bounds each independent page',()=>{
 assert.equal(typeof directory.parseCustomerHistoryQuery,'function');
 for(const value of [{limit:0},{limit:101},{offset:-1},{offset:1.5},{limit:'NaN'},{unknown:1}])assert.throws(()=>directory.parseCustomerHistoryQuery(value));
 assert.deepEqual(directory.parseCustomerHistoryQuery({limit:'25',offset:'100'}),{limit:25,offset:100});
});
test('history pages bind tenant, customer, store and stable order',()=>{
 assert.equal(typeof directory.buildCustomerHistoryQuery,'function');
 for(const kind of ['sales','returns','ledger','open-credits']){
  const query=directory.buildCustomerHistoryQuery({organizationId,customerId,storeId:customerId,kind,limit:25,offset:100});
  assert.deepEqual(query.values,[organizationId,customerId,customerId,26,100]);
  assert.match(query.text,/created_at DESC,\w+\.id DESC/);
  assert.match(query.text,/store_id=\$3/);
 }
 assert.deepEqual(directory.buildCustomerHistoryQuery({organizationId,customerId,kind:'ledger',limit:'25',offset:'100'}).values,[organizationId,customerId,null,26,100]);
});
test('multiple configured customer tags are bound as an array filter',()=>{
 const input=directory.parseCustomerDirectoryQuery({tags:'VIP,WHOLESALE'});
 assert.deepEqual(input.tags,['VIP','WHOLESALE']);
 const query=directory.buildCustomerPageQuery({organizationId,...input});
 assert.deepEqual(query.values[4],['VIP','WHOLESALE']);
 assert.match(query.text,/tags @> \$5::text\[\]/);
});
