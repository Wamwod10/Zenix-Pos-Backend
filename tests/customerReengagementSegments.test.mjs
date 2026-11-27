import test from 'node:test';import assert from 'node:assert/strict';
import {parseCustomerDirectoryQuery,buildCustomerPageQuery} from '../src/services/customerDirectory.js';
const organizationId='11111111-1111-4111-8111-111111111111';
test('reengagement segments use recorded sale recency, exclude archived and retain tenant scope',()=>{
 const filters={'new-30':"c.created_at>=now()-interval '30 days'",'never-purchased':'c.sale_count=0','lapsed-30':"c.last_purchase_at<now()-interval '30 days'",'lapsed-60':"c.last_purchase_at<now()-interval '60 days'",'lapsed-90':"c.last_purchase_at<now()-interval '90 days'"};
 for(const [filter,predicate] of Object.entries(filters)){
  assert.equal(parseCustomerDirectoryQuery({filter}).filter,filter);
  const q=buildCustomerPageQuery({organizationId,filter,limit:60,offset:120,tags:['promo']});
  assert.ok(q.text.includes(predicate));assert.ok(q.text.includes('c.organization_id=$1 AND c.archived=false'));assert.deepEqual(q.values,[organizationId,'%%',60,120,['promo']]);
 }
 assert.throws(()=>parseCustomerDirectoryQuery({filter:'lapsed-999'}));
});
