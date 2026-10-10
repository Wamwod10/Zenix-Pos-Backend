import test from 'node:test';import assert from 'node:assert/strict';import {parseCustomerDirectoryQuery,buildCustomerPageQuery} from '../src/services/customerDirectory.js';
test('CRM supports inactive, regular, latest and most-frequent customers safely',()=>{
 for(const filter of ['regular','inactive','active'])assert.equal(parseCustomerDirectoryQuery({filter}).filter,filter);
 for(const sort of ['latest','newest','frequency'])assert.equal(parseCustomerDirectoryQuery({sort}).sort,sort);
 const result=buildCustomerPageQuery({organizationId:'11111111-1111-4111-8111-111111111111',filter:'inactive',sort:'latest'});
 assert.match(result.text,/c.archived=true/);assert.match(result.text,/last_purchase_at/);
});
