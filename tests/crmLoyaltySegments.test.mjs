import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCustomerDirectoryQuery,buildCustomerPageQuery} from '../src/services/customerDirectory.js';
const org='11111111-1111-4111-8111-111111111111';
test('loyalty segmentation distinguishes customer type and loyalty tier, remains scoped and paginated',()=>{
 const filters={wholesale:"c.customer_type='WHOLESALE'",'tier-standard':"c.loyalty_tier='STANDARD'",'tier-silver':"c.loyalty_tier='SILVER'",'tier-gold':"c.loyalty_tier='GOLD'",'tier-vip':"c.loyalty_tier='VIP'",'loyalty-points':'c.loyalty_points>0'};
 for(const [filter,sql] of Object.entries(filters)){
  const query=buildCustomerPageQuery({organizationId:org,filter,sort:'points',direction:'desc',limit:20,offset:40,tags:['promo']});
  assert.ok(query.text.includes(sql));assert.ok(query.text.includes("c.organization_id=$1 AND c.archived=false"));
  assert.ok(query.text.includes("c.loyalty_points DESC NULLS LAST,c.id ASC"));
  assert.ok(query.text.includes("LIMIT $3 OFFSET $4"));assert.deepEqual(query.values.slice(2,5),[20,40,['promo']]);
  assert.equal(query.values[0],org);
 }
 assert.ok(buildCustomerPageQuery({organizationId:org,filter:'vip'}).text.includes("c.customer_type='VIP'"));
 assert.throws(()=>parseCustomerDirectoryQuery({filter:"tier-gold' OR true"}));
 assert.throws(()=>parseCustomerDirectoryQuery({sort:'points;DROP TABLE customers'}));
});
