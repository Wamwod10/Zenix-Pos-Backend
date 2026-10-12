import test from 'node:test';import assert from 'node:assert/strict';import {buildCustomerPageQuery} from '../src/services/customerDirectory.js';
const organizationId='11111111-1111-4111-8111-111111111111';
test('formatted and plain phone queries bind normalized digits without broadening name searches',()=>{
 for(const q of ['+998 (90) 123-45-67','998901234567']){const query=buildCustomerPageQuery({organizationId,q});assert.equal(query.values[5],'%998901234567%');assert.match(query.text,/regexp_replace\(COALESCE\(phone,''\),'\[\^0-9\]','','g'\) LIKE \$6/);assert.match(query.text,/c.organization_id=\$1 AND c.archived=false/);}
 for(const q of ['Aziza','Customer 12','+() -','']){const query=buildCustomerPageQuery({organizationId,q});assert.equal(query.values.length,5);assert.doesNotMatch(query.text,/LIKE \$6/);}
});
