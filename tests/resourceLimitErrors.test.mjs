import test from 'node:test';
import assert from 'node:assert/strict';
import {errorHandler} from '../src/middleware/error.js';
const limits=await import('../src/services/resourceLimits.js').catch(()=>({}));

test('limit failures expose the counted resource, usage and actual upgrade availability',()=>{
  for(const [resource,code] of [['employees','EMPLOYEE_LIMIT'],['stores','STORE_LIMIT'],['warehouses','WAREHOUSE_LIMIT'],['registers','REGISTER_LIMIT'],['products','PRODUCT_LIMIT'],['customers','CUSTOMER_LIMIT']]){
    let status,body;
    errorHandler({code:'ZX409',detail:JSON.stringify({resource,planCode:'START',limit:2,used:2,requestedIncrease:1,upgradeRequired:true,upgradeAvailable:true})},{},{status(value){status=value;return this},json(value){body=value}},()=>{});
    assert.equal(status,409);assert.equal(body.error.code,code);assert.equal(body.error.details.limit,2);assert.equal(body.error.details.used,2);assert.equal(body.error.details.upgradeRequired,true);
  }
});
test('capacity service refuses unknown resources and non-positive increments before SQL',async()=>{
  assert.equal(typeof limits.assertResourceCapacity,'function');
  const db={query:async()=>{throw Error('SQL must not run')}};
  for(const [resource,increase] of [['organizations',1],['products',0],['registers',1.5]])await assert.rejects(()=>limits.assertResourceCapacity(db,'tenant',resource,increase),{code:'INVALID_RESOURCE_LIMIT_REQUEST'});
});
