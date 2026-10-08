import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HttpError } from '../src/lib/http.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const read=(relative)=>fs.readFileSync(path.join(here,'..',relative),'utf8');

// Execute the real transaction helpers without loading the configured app pool.
const inventorySource=read('src/routes/inventory.js');
const countHelpers=vm.runInNewContext(`${inventorySource.slice(inventorySource.indexOf('async function lockBalance'),inventorySource.indexOf('async function allocateTransferTracking'))}
${inventorySource.slice(inventorySource.indexOf('async function applyCount'),inventorySource.indexOf('router.post("/counts"'))}
({reconcileCountBatches,applyCount})`,{HttpError});

function countClient({batches=[],balance=5,serials=0}={}){
  const state={batches:structuredClone(batches),balance,writes:[],locks:[]};
  return {state,async query(sql,args=[]){
    if(sql.includes('SELECT id,remaining_quantity FROM inventory_batches')){
      assert.match(sql,/FOR UPDATE/);
      state.locks.push(args);
      return {rows:state.batches.filter(row=>row.organization_id===args[0]&&row.store_id===args[1]&&row.product_id===args[2]&&(!sql.includes('remaining_quantity>0')||row.remaining_quantity>0))
        .sort((a,b)=>(a.expiry_date??'9999').localeCompare(b.expiry_date??'9999')||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))};
    }
    if(sql.startsWith('UPDATE inventory_batches')){
      state.writes.push({id:args[0],quantity:Number(args[1])});
      state.batches.find(row=>row.id===args[0]).remaining_quantity-=args[1];return {rows:[]};
    }
    if(sql.includes('INSERT INTO inventory_batches')){
      const quantity=Number(args.at(-1));
      state.writes.push({insert:quantity});
      state.batches.push({id:'count-batch',organization_id:args[0],store_id:args[1],product_id:args[2],remaining_quantity:quantity,received_quantity:quantity,
        batch_no:'INVENTORY-COUNT / EXPIRY-UNKNOWN',expiry_date:null,created_at:'2026-10-09'});return {rows:[]};
    }
    if(sql.includes('FROM product_serials'))return {rows:[{total:serials,in_stock:serials}]};
    if(sql.includes('FROM inventory_batches'))return {rows:[{total:state.batches.length,remaining:0}]};
    if(sql.includes('SELECT id,name,unit,min_stock FROM products'))return {rows:[{id:'product',name:'Counted item'}]};
    if(sql.includes('INSERT INTO inventory_balances'))return {rows:[]};
    if(sql.includes('SELECT * FROM inventory_balances'))return {rows:[{quantity:state.balance}]};
    if(sql.includes('UPDATE inventory_balances')){state.balance=args[3];return {rows:[]};}
    if(sql.includes('INSERT INTO stock_movements'))return {rows:[{quantity:args[3]}]};
    throw new Error(`Unexpected inventory count query: ${sql}`);
  }};
}
const lot=(id,quantity,overrides={})=>({id,organization_id:'org',store_id:'store',product_id:'product',remaining_quantity:quantity,received_quantity:Math.max(1,quantity),expiry_date:'2027-01-01',created_at:'2026-01-01',...overrides});
const countOptions=(after,before=5)=>({orgId:'org',storeId:'store',changes:[{productId:'product',before,after}],userId:'user',countId:'count',strictSnapshot:true});

for(const fixture of [
  {name:'pre-existing aggregate drift',balance:20,requested:7,batches:[lot('a',3),lot('b',2)],want:[3,2,2]},
  {name:'zero-positive historical lots',balance:0,requested:3,batches:[lot('a',0)],want:[0,3]},
  {name:'decrease',balance:5,requested:2,batches:[lot('a',3),lot('b',2)],want:[0,2]},
  {name:'increase',balance:5,requested:8,batches:[lot('a',3),lot('b',2)],want:[3,2,3]},
  {name:'exact equality',balance:20,requested:5,batches:[lot('a',3),lot('b',2)],want:[3,2]},
  {name:'fractional exact equality',balance:1,requested:0.3,batches:[lot('a',0.1),lot('b',0.2)],want:[0.1,0.2]},
  {name:'other-store and other-tenant lots',balance:5,requested:4,batches:[lot('a',2),lot('other-store',9,{store_id:'elsewhere'}),lot('other-tenant',11,{organization_id:'other'})],want:[2,9,11,2]},
])test(`batch reconciliation handles ${fixture.name}`,async()=>{
  const client=countClient(fixture);
  await countHelpers.reconcileCountBatches(client,{organizationId:'org',storeId:'store',productId:'product',requestedBalance:fixture.requested});
  assert.deepEqual(client.state.batches.map(row=>row.remaining_quantity),fixture.want);
  assert.deepEqual(Array.from(client.state.locks[0]),['org','store','product']);
  if(fixture.name.includes('equality'))assert.equal(client.state.writes.length,0,'exact batch total must be a no-op');
});

test('batch reconciliation consumes deterministically by expiry, creation and ID',async()=>{
  const client=countClient({batches:[lot('z',2,{expiry_date:null}),lot('b',3),lot('a',3),lot('older',1,{created_at:'2025-01-01'})]});
  await countHelpers.reconcileCountBatches(client,{organizationId:'org',storeId:'store',productId:'product',requestedBalance:4});
  assert.deepEqual(client.state.writes,[{id:'older',quantity:1},{id:'a',quantity:3},{id:'b',quantity:1}]);
  assert.deepEqual(client.state.batches.map(row=>row.remaining_quantity),[2,2,0,0]);
});

test('batch reconciliation retains exact thousandths at large PostgreSQL numeric quantities',async()=>{
  const updates=[];
  const client={async query(sql,args){
    if(sql.includes('SELECT id,remaining_quantity'))return {rows:[{id:'large-lot',remaining_quantity:'10000000000000.001'}]};
    if(sql.startsWith('UPDATE inventory_batches')){updates.push([args[0],Number(args[1])]);return {rows:[]};}
    throw new Error(`Unexpected reconciliation query: ${sql}`);
  }};
  await countHelpers.reconcileCountBatches(client,{organizationId:'org',storeId:'store',productId:'product',requestedBalance:10000000000000});
  assert.deepEqual(updates,[['large-lot',0.001]]);
});

test('inventory count repairs batch drift even when aggregate balance is unchanged',async()=>{
  const client=countClient({balance:5,batches:[lot('a',2)]});
  const result=await countHelpers.applyCount(client,countOptions(5));
  assert.deepEqual(client.state.batches.map(row=>row.remaining_quantity),[2,3]);
  assert.equal(client.state.balance,5);
  assert.equal(result.movements.length,0);
});

test('inventory count excludes serial-tracked aggregate changes before batch mutations',async()=>{
  const client=countClient({serials:1,batches:[lot('a',2)]});
  await assert.rejects(countHelpers.applyCount(client,countOptions(7)),error=>error.code==='TRACKED_SERIAL_ADJUSTMENT_REQUIRED');
  assert.equal(client.state.balance,5);assert.equal(client.state.writes.length,0);
});

test('inventory count leaves unchanged serial-tracked inventory and batches untouched',async()=>{
  const client=countClient({serials:1,batches:[lot('a',2)]});
  await countHelpers.applyCount(client,countOptions(5));
  assert.equal(client.state.writes.length,0);assert.equal(client.state.locks.length,0);
});

test('sales transaction persists authoritative serial and batch tracking',()=>{
  const sales=read('src/routes/sales.js');
  assert.match(sales,/tracking\?\.serials/);
  assert.match(sales,/consumeInventoryBatches/);
  assert.match(sales,/restoreInventoryBatches/);
  assert.match(sales,/authoritativeTracking/);
  assert.match(sales,/Bir mahsulot savdoda faqat bitta qatorda/);
  assert.match(sales,/assertSharedOpenShift/);
});

test('inventory bulk operations reject duplicate product rows',()=>{
  const inventory=read('src/routes/inventory.js');
  assert.match(inventory,/uniqueProductArray/);
  assert.match(inventory,/TRANSFER_ITEM_INVALID/);
  assert.match(inventory,/Bir mahsulot inventarizatsiyada faqat bir marta/);
});

test('telegram delivery ledger is per connection to prevent duplicate fan-out retries',()=>{
  const migration=read('migrations/003_notification_delivery_hardening.sql');
  const worker=read('src/services/notificationWorker.js');
  assert.match(migration,/notification_deliveries/);
  assert.match(migration,/UNIQUE\s*\(outbox_id,\s*connection_id\)/i);
  assert.match(worker,/notification_deliveries/);
  assert.match(worker,/deliveryContext/);
});

test('store restore cannot bypass licensed store limit',()=>{
  const stores=read('src/routes/stores.js');
  assert.match(stores,/input\.active\s*===\s*true\s*&&\s*!store\.active/);
  assert.match(stores,/store_limit/);
  assert.match(stores,/STORE_LIMIT/);
});


test('sales enforce server-side POS pricing, discount and payment rules',()=>{
  const sales=read('src/routes/sales.js');
  assert.match(sales,/effectivePosRules/);
  assert.match(sales,/DISCOUNT_FORBIDDEN/);
  assert.match(sales,/DISCOUNT_LIMIT_EXCEEDED/);
  assert.match(sales,/PAYMENT_METHOD_DISABLED/);
  assert.match(sales,/normalizedLinePricing/);
});

test('transfers keep serial and batch tracking authoritative across dispatch, receive and cancel',()=>{
  const inventory=read('src/routes/inventory.js');
  const migration=read('migrations/004_transfer_tracking.sql');
  const bootstrap=read('src/routes/bootstrap.js');
  assert.match(inventory,/allocateTransferTracking/);
  assert.match(inventory,/receiveTransferTracking/);
  assert.match(inventory,/restoreTransferTrackingToSource/);
  assert.match(inventory,/status='IN_TRANSIT'/);
  assert.match(inventory,/status='MISSING'/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS metadata jsonb/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS transfer_id uuid/);
  assert.match(bootstrap,/'metadata',ti\.metadata/);
});

test('telegram webhook stays public while protected settings stay authenticated',()=>{
  const telegram=read('src/routes/telegram.js');
  const webhookIndex=telegram.indexOf('router.post("/webhook"');
  const protectedMountIndex=telegram.indexOf('router.use(protectedRouter)');
  assert.ok(webhookIndex>=0&&protectedMountIndex>webhookIndex,'public webhook must be registered before protected router');
  assert.match(telegram,/TELEGRAM_SETTING_KEYS/);
  assert.match(telegram,/"transfers"/);
});

test('count reconciles batch ledger while ordinary adjustments and serial changes remain guarded',()=>{
  const inventory=read('src/routes/inventory.js');
  assert.match(inventory,/TRACKED_SERIAL_ADJUSTMENT_REQUIRED/);
  assert.match(inventory,/TRACKED_BATCH_ADJUSTMENT_REQUIRED/);
  assert.match(inventory,/if\(batchTotal>0&&!allowBatchReconciliation\)/);
  assert.match(inventory,/applyCount[\s\S]*allowBatchReconciliation:true/);
  assert.match(inventory,/reconcileCountBatches\(client,/);
  assert.match(inventory,/FOR UPDATE/);
  assert.match(inventory,/remaining_quantity=remaining_quantity-\$2/);
  assert.match(inventory,/INVENTORY-COUNT \/ EXPIRY-UNKNOWN/);
});

test('transfer lifecycle queues telegram notification events',()=>{
  const inventory=read('src/routes/inventory.js');
  const worker=read('src/services/notificationWorker.js');
  const formatter=read('src/services/telegram.js');
  for(const event of ['inventory.transfer_dispatched','inventory.transfer_received','inventory.transfer_cancelled']){
    assert.match(inventory,new RegExp(event.replaceAll('.','\\.')));
    assert.match(worker,new RegExp(event.replaceAll('.','\\.')));
    assert.match(formatter,new RegExp(event.replaceAll('.','\\.')));
  }
});

test('one branch shift is shared while dangerous controls remain permission guarded',()=>{
  const shifts=read('src/routes/shifts.js');
  const bootstrap=read('src/routes/bootstrap.js');
  const sales=read('src/routes/sales.js');
  assert.match(shifts,/findOpenBranchShiftWithLock/);
  assert.match(shifts,/branchRegisterKey/);
  assert.match(shifts,/assertShiftControl/);
  assert.match(bootstrap,/selectActiveBranchShifts/);
  assert.match(sales,/assertSharedOpenShift/);
  assert.doesNotMatch(sales,/shift\.cashier_id\)!==String\(req\.user\.id\)/);
  assert.match(sales,/seller_id/);
  assert.match(sales,/req\.user\.id/);
});

test('tracked batch transfers reject over-receipt that would desync batch ledgers',()=>{
  const inventory=read('src/routes/inventory.js');
  assert.match(inventory,/tracking\?\.fullyBatched&&received>sent/);
  assert.match(inventory,/BATCH_TRANSFER_OVER_RECEIPT/);
});

test('Telegram API requests have a bounded network timeout',()=>{
  const telegram=read('src/services/telegram.js');
  assert.match(telegram,/AbortSignal\.timeout\(15000\)/);
});

test('daily reports keep returns on the business day the refund was processed',()=>{
  const migration=read('migrations/006_return_business_day.sql');
  const sales=read('src/routes/sales.js');
  const bootstrap=read('src/routes/bootstrap.js');
  assert.match(migration,/sale_returns ADD COLUMN IF NOT EXISTS business_date/);
  assert.match(sales,/returnBusinessDate=organizationBusinessDateISO/);
  assert.match(sales,/INSERT INTO sale_returns[\s\S]*business_date/);
  assert.match(sales,/day_returns[\s\S]*business_date=\$3/);
  assert.match(sales,/BUSINESS_DAY_CLOSED/);
  assert.match(bootstrap,/businessDateISO:databaseDateISO\(row\.business_date\|\|parts\.dateISO\)/);
});

test('manual supplier invoices persist their initial payment in the payment ledger',()=>{
  const suppliers=read('src/routes/suppliers.js');
  assert.match(suppliers,/paidAmount:z\.coerce\.number\(\)\.min\(0\)/);
  assert.match(suppliers,/INSERT INTO supplier_payments\(organization_id,supplier_id,invoice_id,store_id,amount,method,note,created_by\)/);
  assert.match(suppliers,/Nakladnoy yaratilishidagi boshlang‘ich to‘lov/);
});

test('POS payment rules reject duplicate methods and disabled split payments on the server',()=>{
  const sales=read('src/routes/sales.js');
  assert.match(sales,/DUPLICATE_PAYMENT_METHOD/);
  assert.match(sales,/SPLIT_PAYMENT_DISABLED/);
  assert.match(sales,/posRules\.paymentMethods\?\.split===false/);
});

test('serial identifiers have a database-level case-insensitive uniqueness guard',()=>{
  const migration=read('migrations/008_serial_case_insensitive_unique.sql');
  const errors=read('src/middleware/error.js');
  assert.match(migration,/product_serials_org_serial_ci_unique/);
  assert.match(migration,/lower\(serial\)/);
  assert.match(errors,/product_serials_org_serial_ci_unique/);
});
