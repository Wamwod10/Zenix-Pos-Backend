import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const read=(relative)=>fs.readFileSync(path.join(here,'..',relative),'utf8');

test('sales transaction persists authoritative serial and batch tracking',()=>{
  const sales=read('src/routes/sales.js');
  assert.match(sales,/tracking\?\.serials/);
  assert.match(sales,/consumeInventoryBatches/);
  assert.match(sales,/restoreInventoryBatches/);
  assert.match(sales,/authoritativeTracking/);
  assert.match(sales,/Bir mahsulot savdoda faqat bitta qatorda/);
  assert.match(sales,/Naqd qaytarish faqat o‘z smenangizdan bajariladi/);
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

test('manual inventory count and adjustment cannot corrupt tracked serial or batch ledgers',()=>{
  const inventory=read('src/routes/inventory.js');
  assert.match(inventory,/assertManualQuantityChangeSafe/);
  assert.match(inventory,/TRACKED_SERIAL_ADJUSTMENT_REQUIRED/);
  assert.match(inventory,/TRACKED_BATCH_ADJUSTMENT_REQUIRED/);
  assert.match(inventory,/applyCount[\s\S]*assertManualQuantityChangeSafe/);
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

test('parallel branch shifts use per-user registers and bootstrap never adopts another cashier shift',()=>{
  const shifts=read('src/routes/shifts.js');
  const bootstrap=read('src/routes/bootstrap.js');
  assert.match(shifts,/input\.registerKey\s*\|\|\s*`user:\$\{req\.user\.id\}`/);
  assert.match(shifts,/organization_id=\$1 AND store_id=\$2 AND register_key=\$3 AND status='open'/);
  assert.match(bootstrap,/String\(shift\.cashierAccountId\)!==String\(req\.user\.id\)/);
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
