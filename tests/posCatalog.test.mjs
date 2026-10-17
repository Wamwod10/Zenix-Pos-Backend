import test from 'node:test';
import assert from 'node:assert/strict';
import {posCatalogQuerySchema,encodePosCatalogCursor,decodePosCatalogCursor} from '../src/lib/posCatalog.js';
const storeId='00000000-0000-4000-8000-000000000001';
test('POS catalog validates bounded lookup modes',()=>{
 assert.equal(posCatalogQuerySchema.parse({storeId}).limit,50);
 for(const input of [{limit:101},{storeId:'bad'},{ids:Array(101).fill(storeId).join(',')},{ids:storeId,search:'milk'},{barcode:'123',search:'milk'},{unknown:'x'}])assert.equal(posCatalogQuerySchema.safeParse({storeId,...input}).success,false);
 assert.deepEqual(posCatalogQuerySchema.parse({storeId,ids:`${storeId},${storeId}`}).ids,[storeId]);
});
test('POS pagination preserves PostgreSQL microseconds',()=>{
 const row={id:storeId,cursor_created_at:'2026-10-17T12:01:02.123456Z'};
 assert.deepEqual(decodePosCatalogCursor(encodePosCatalogCursor(row)),{createdAt:row.cursor_created_at,id:storeId});
 for(const token of ['%%%',Buffer.from('{}').toString('base64url')])assert.throws(()=>decodePosCatalogCursor(token),{code:'INVALID_CATALOG_CURSOR'});
});
import {readPosCatalog} from '../src/services/posCatalog.js';
const orgId='00000000-0000-4000-8000-000000000002';
const cashier={appRole:'CASHIER',organizationId:orgId,storeId};
test('catalog permission and branch scope reject before database reads',async()=>{
 const client={query(){assert.fail('unauthorized requests must not query')}};
 await assert.rejects(readPosCatalog(client,{...cashier,permissionOverrides:{moduleSales:false}},{storeId}),{status:403});
 await assert.rejects(readPosCatalog(client,cashier,{storeId:orgId}),{code:'STORE_FORBIDDEN'});
});
test('catalog lookup returns missing IDs and authoritative scoped tracking over metadata',async()=>{
 const missing='00000000-0000-4000-8000-000000000003';let calls=0;
 const client={async query(sql,params){calls++;
  if(calls===1){assert.deepEqual(params,[storeId,orgId]);return {rows:[{id:storeId}]}}
  if(calls===2){assert.match(sql,/WITH page AS MATERIALIZED/);assert.match(sql,/ps\.store_id=\$2/);assert.match(sql,/ib\.store_id=\$2/);assert.deepEqual(params.slice(0,3),[orgId,storeId,[storeId,missing]]);return {rows:[{id:storeId,metadata:{serializedUnits:['stale'],stockBatches:['stale'],variants:[{name:'red'}]},serialized_units:[],stock_batches:[],stock_by_store:{[storeId]:2}}]}}
  return {rows:[{category:'Food'}]};
 }};
 const result=await readPosCatalog(client,cashier,{storeId,ids:`${storeId},${missing}`,limit:1});
 assert.deepEqual(result.missingIds,[missing]);assert.deepEqual(result.products[0].serializedUnits,[]);assert.deepEqual(result.products[0].stockBatches,[]);assert.deepEqual(result.products[0].variants,[{name:'red'}]);assert.deepEqual(result.categories,['Food']);
});
test('exact duplicate barcode returns explicit ambiguity',async()=>{
 let calls=0;const client={async query(){return {rows:++calls===1?[{id:storeId}]:[{id:storeId},{id:orgId}]}}};
 await assert.rejects(readPosCatalog(client,cashier,{storeId,barcode:'123'}),{code:'AMBIGUOUS_BARCODE',status:409});
});
