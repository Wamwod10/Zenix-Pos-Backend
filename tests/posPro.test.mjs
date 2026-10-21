import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePosProPayment,readPosProSummary} from '../src/services/posPro.js';
const storeId='00000000-0000-4000-8000-000000000001',org='00000000-0000-4000-8000-000000000002';
test('legacy sales stay compatible; POS Pro external payments require explicit manual confirmation',()=>{
 validatePosProPayment({payments:[{method:'card',amount:10}],metadata:{}});
 assert.throws(()=>validatePosProPayment({payments:[{method:'card',amount:10}],metadata:{source:'pos-pro'}}),{code:'EXTERNAL_PAYMENT_UNCONFIRMED'});
 validatePosProPayment({payments:[{method:'card',amount:10}],metadata:{source:'pos-pro',externalPaymentConfirmation:'manual-confirmed'}});
 assert.throws(()=>validatePosProPayment({payments:[{method:'cash',amount:10}],metadata:{source:'pos-pro',cashTendered:9}}),{code:'INVALID_CASH_TENDERED'});
});
test('summary rejects tenant/branch/permission bypass before any query',async()=>{
 const db={query(){assert.fail('must not query')}};
 await assert.rejects(readPosProSummary(db,{appRole:'CASHIER',organizationId:org,storeId},{storeId:org}),{code:'STORE_FORBIDDEN'});
 await assert.rejects(readPosProSummary(db,{appRole:'CASHIER',organizationId:org,storeId,permissionOverrides:{moduleSales:false}},{storeId}),{status:403});
});
