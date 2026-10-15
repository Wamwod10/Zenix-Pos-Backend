import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const {AGENT_TOOL_SCHEMAS,normalizeAgentUnit,validateAgentReceipt,runAgentTool}=await import('../src/services/aiAgentTools.js');
const {confirmAgentAction,publicAgentAction}=await import('../src/services/aiAgentActions.js');
const {assertAgentEnabled,assertAgentPermission,recheckAgentActor,requireAgentReservation}=await import('../src/services/aiAgentActor.js');
const {authorizationKey}=await import('../src/services/aiPolicy.js');
const {inventoryReceiptSchema}=await import('../src/services/inventoryReceipt.js');
const valid={productId:randomUUID(),storeId:randomUUID(),warehouseId:randomUUID(),quantity:10,unit:'kg',costPrice:15000,batchNo:null,expiryDate:null};
const user={id:randomUUID(),organizationId:randomUUID(),sessionId:randomUUID(),appRole:'OWNER',storeId:null,permissionOverrides:{},rolePermissions:{}};
test('strict tools accept only server-scoped arguments and quantity precision',()=>{
 for(const args of [{...valid,organizationId:randomUUID()},{...valid,supplierId:randomUUID()},{...valid,serials:['a']},{...valid,quantity:0},{...valid,quantity:0.0001},{...valid,costPrice:-1},{...valid,costPrice:1.234},{...valid,expiryDate:'2026-02-30'}])assert.equal(AGENT_TOOL_SCHEMAS.prepare_stock_receipt.safeParse(args).success,false);
 assert.equal(AGENT_TOOL_SCHEMAS.prepare_stock_receipt.safeParse(valid).success,true);
 assert.equal(AGENT_TOOL_SCHEMAS.search_products.safeParse({query:'RICE',storeId:randomUUID()}).success,false);
 assert.equal(AGENT_TOOL_SCHEMAS.list_locations.safeParse({organizationId:randomUUID()}).success,false);
});
test('clarifications never invent cost, warehouse, units, serials or batch metadata',()=>{
 const product={unit:'kg',metadata:{}};
 for(const unit of ['kg','kilo','kilogram','KILOGRAMM'])assert.equal(normalizeAgentUnit(unit),'kg');
 assert.equal(validateAgentReceipt({...valid,unit:'kilo'},product),null);
 assert.deepEqual(validateAgentReceipt({...valid,costPrice:null,warehouseId:null},product).fields,['warehouseId','costPrice']);
 assert.deepEqual(validateAgentReceipt({...valid,unit:'dona'},product).fields,['unit','quantity']);
 assert.equal(validateAgentReceipt(valid,{...product,metadata:{trackingMode:'serial'}}).code,'AI_SERIAL_UNSUPPORTED');
 assert.deepEqual(validateAgentReceipt(valid,{...product,metadata:{lotTracking:true}}).fields,['batchNo']);
 assert.deepEqual(validateAgentReceipt({...valid,batchNo:'B1'},{...product,metadata:{lotTracking:true,expiryDate:'2026-12-01'}}).fields,['expiryDate']);
 assert.equal(validateAgentReceipt({...valid,batchNo:'B1',expiryDate:'2026-12-02'},{...product,metadata:{lotTracking:true}}),null);
 assert.throws(()=>validateAgentReceipt({...valid,quantity:999999999,costPrice:999999999},product),e=>e.code==='AI_RECEIPT_LIMIT');
});
test('write gates default closed and confirmation accepts id+token only',async()=>{
 assert.throws(()=>assertAgentEnabled({enabled:true},{write:true}),e=>e.code==='AI_WRITES_DISABLED');
 assert.throws(()=>assertAgentEnabled({enabled:false,writesEnabled:true},{write:true}),e=>e.code==='AI_UNAVAILABLE');
 await assert.rejects(()=>runAgentTool(user,'confirm_stock_receipt',{}, {settings:{enabled:true}}),e=>e.code==='AI_TOOL_UNSUPPORTED');
 await assert.rejects(()=>confirmAgentAction(user,randomUUID(),{confirmationToken:'a'.repeat(43),quantity:999},{settings:{enabled:true,writesEnabled:true}}));
 assert.throws(()=>assertAgentPermission({...user,appRole:'CASHIER'},'moduleInventory','inventoryAdjust'),e=>e.code==='AI_FORBIDDEN');
 assert.throws(()=>assertAgentPermission({...user,appRole:'PLATFORM_ADMIN'},'moduleProducts'),e=>e.code==='AI_FORBIDDEN');
});
test('original HTTP receipt schema retains defaults and supplier behavior',()=>{
 const receipt=inventoryReceiptSchema.parse({storeId:valid.storeId,lines:[{productId:valid.productId,quantity:10,costPrice:15000}]});
 assert.equal(receipt.lines[0].unit,'dona');assert.deepEqual(receipt.lines[0].serials,[]);assert.equal(receipt.clientReference,'');
 assert.throws(()=>inventoryReceiptSchema.parse({...receipt,supplierId:randomUUID(),newSupplier:{name:'Supplier'}}));
});
test('actor validity, paid plan, auth fingerprint and successful request association rechecked',async()=>{
 const key=authorizationKey(user),org={settings:{},plan_code:'BUSINESS',code:'BUSINESS',pricing_version:1,writable:true};
 const actor={app_role:'OWNER',store_id:null,permission_overrides:{},active:true,must_change_password:false};
 const db={query:async sql=>({rows:[sql.includes('FROM organizations')?org:actor]})};
 assert.equal((await recheckAgentActor(db,user,key)).id,user.id);
 actor.active=false;await assert.rejects(()=>recheckAgentActor(db,user,key),e=>e.code==='AI_ACCESS_CHANGED');actor.active=true;
 org.code='START';await assert.rejects(()=>recheckAgentActor(db,user,key),e=>e.code==='AI_PLAN_REQUIRED');org.code='BUSINESS';
 const actionId=randomUUID(),row={authorization_key:key,status:'SUCCEEDED',response:{actions:[{id:actionId}]},response_expires_at:new Date(Date.now()+10000)};
 const requestDb={query:async()=>({rows:[row]})};
 await requireAgentReservation(requestDb,user,randomUUID(),key,{completed:true,actionId});
 await assert.rejects(()=>requireAgentReservation(requestDb,user,randomUUID(),key,{completed:true,actionId:randomUUID()}),e=>e.code==='AI_REQUEST_REQUIRED');
 row.status='FAILED';await assert.rejects(()=>requireAgentReservation(requestDb,user,randomUUID(),key,{completed:true,actionId}),e=>e.code==='AI_REQUEST_REQUIRED');
});
test('public action omits fixed server payload, actor, fingerprint and terminal token',()=>{
 const row={id:randomUUID(),type:'stock_receipt',status:'CONFIRMED',expires_at:new Date(),preview:{quantity:10},confirmation_token:'secret',payload:{secret:'server'},authorization_key:'secret',result:{delta:10}};
 const view=publicAgentAction(row,{token:true});assert.equal(view.action.confirmationToken,undefined);assert.equal(view.action.payload,undefined);assert.equal(view.action.authorization_key,undefined);assert.equal(view.action.result.delta,10);
});
