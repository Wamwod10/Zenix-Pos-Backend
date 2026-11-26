import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCustomerDirectoryQuery,buildCustomerPageQuery,buildCustomerHistoryQuery} from '../src/services/customerDirectory.js';
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

test('loyalty history scopes ledger and sales joins by tenant, customer and branch',()=>{
 const customerId='22222222-2222-4222-8222-222222222222',storeId='33333333-3333-4333-8333-333333333333';
 const q=buildCustomerHistoryQuery({organizationId:org,customerId,storeId,kind:'loyalty',limit:50,offset:100});
 assert.match(q.text,/l.organization_id=\$1 AND l.customer_id=\$2/);
 assert.match(q.text,/s.organization_id=l.organization_id AND s.customer_id=l.customer_id/);
 assert.match(q.text,/s.store_id=\$3/);assert.match(q.text,/LIMIT \$4 OFFSET \$5/);
 assert.deepEqual(q.values,[org,customerId,storeId,51,100]);
});
