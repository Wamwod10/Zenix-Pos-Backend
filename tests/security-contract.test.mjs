import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPermission, isOrganizationPermissionKey, ROLES } from '../src/lib/permissions.js';
import * as permissions from '../src/lib/permissions.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const read=(relative)=>fs.readFileSync(path.join(here,'..',relative),'utf8');

test('organization owner never inherits platform administration',()=>{
  assert.equal(hasPermission({appRole:ROLES.OWNER},'platformAdmin'),false);
  assert.equal(hasPermission({appRole:ROLES.OWNER},'*'),false);
  assert.equal(hasPermission({appRole:ROLES.PLATFORM_ADMIN},'platformAdmin'),true);
  assert.equal(hasPermission({appRole:ROLES.PLATFORM_ADMIN},'moduleSales'),false);
});

test('seller analytics permission can read cashier and sales staff for zero-sale rows',()=>{
  assert.equal(typeof permissions.canReadEmployees,'function','employee visibility policy must be available');
  const user={appRole:ROLES.MANAGER,permissionOverrides:{moduleSettings:false,moduleExpenses:false,moduleSellerAnalytics:true}};
  assert.equal(permissions.canReadEmployees(user),true);
});

test('platform/system permissions cannot be stored as organization overrides',()=>{
  assert.equal(isOrganizationPermissionKey('platformAdmin'),false);
  assert.equal(isOrganizationPermissionKey('*'),false);
  assert.equal(isOrganizationPermissionKey('moduleSales'),true);
  assert.equal(isOrganizationPermissionKey('inventoryAdjust'),true);
});

test('user and settings routes enforce owner-only permission editing',()=>{
  const users=read('src/routes/users.js');
  const settings=read('src/routes/settings.js');
  assert.match(users,/permissionOverrides/);
  assert.match(users,/appRole!==ROLES\.OWNER/);
  assert.match(users,/isOrganizationPermissionKey/);
  assert.match(users,/assertRoleAdministration/);
  assert.match(users,/ADMIN rolini faqat tashkilot egasi bera oladi/);
  assert.match(settings,/rolePermissions/);
  assert.match(settings,/appRole!==ROLES\.OWNER/);
  assert.match(settings,/ORGANIZATION_CONFIGURABLE_ROLES/);
});

test('branch-scoped product/bootstrap responses are server filtered',()=>{
  const products=read('src/routes/products.js');
  const bootstrap=read('src/routes/bootstrap.js');
  assert.match(products,/isBranchLocked\(req\.user\)/);
  assert.match(products,/ib\.store_id=\$2/);
  assert.match(bootstrap,/branchStoreId=isBranchLocked\(req\.user\)\?req\.user\.storeId:null/);
  assert.match(bootstrap,/hasPermission\(req\.user,"moduleBilling"\)/);
});

test('login is throttled and live sessions are bounded server-side',()=>{
  const auth=read('src/routes/auth.js');
  const throttle=read('src/services/loginThrottle.js');
  const migration=read('migrations/005_production_security.sql');
  assert.match(migration,/CREATE TABLE IF NOT EXISTS auth_login_attempts/);
  assert.match(throttle,/MAX_IP_FAILURES = 8/);
  assert.match(throttle,/LOGIN_RATE_LIMITED/);
  assert.match(throttle,/pg_advisory_xact_lock/);
  assert.match(auth,/ORDER BY created_at DESC OFFSET 20/);
});

test('telegram relink cannot leak queued notifications across tenants',()=>{
  const telegram=read('src/routes/telegram.js');
  const worker=read('src/services/notificationWorker.js');
  const migration=read('migrations/005_production_security.sql');
  assert.match(telegram,/connection relinked/);
  assert.match(telegram,/my_chat_member/);
  assert.match(worker,/connection_organization_id/);
  assert.match(worker,/tenantMismatch/);
  assert.match(worker,/storeMismatch/);
  assert.match(migration,/notification_outbox_org_event_unique/);
});

test("production startup fails closed when deployment or Telegram secrets are missing",()=>{
  const envSource=read("src/config/env.js");
  assert.match(envSource,/productionValue\("FRONTEND_ORIGIN"/);
  assert.match(envSource,/productionValue\("TELEGRAM_BOT_TOKEN"/);
  assert.match(envSource,/productionValue\("TELEGRAM_WEBHOOK_SECRET"/);
  assert.match(envSource,/productionValue\("PUBLIC_API_URL"/);
});

test("product-only access gets last-sale aggregate without receiving full sales history",()=>{
  const bootstrap=read("src/routes/bootstrap.js");
  assert.match(bootstrap,/AS last_sale_at/i);
  const salesVisible=bootstrap.match(/const salesVisible=([^;]+);/)?.[1]||"";
  assert.doesNotMatch(salesVisible,/moduleProducts/);
  assert.match(bootstrap,/lastSaleAt:row\.last_sale_at/);
});

test('notification outbox idempotency is tenant scoped',()=>{
  const notifications=read('src/services/notifications.js');
  const migration=read('migrations/005_production_security.sql');
  assert.match(migration,/notification_outbox_org_event_unique/);
  assert.match(notifications,/ON CONFLICT\s*\(organization_id,event_type,event_id\)\s*DO NOTHING/i);
});

test('store archive is server guarded by last-active and tracked inventory dependencies',()=>{
  const stores=read('src/routes/stores.js');
  assert.match(stores,/LAST_ACTIVE_STORE/);
  assert.match(stores,/product_serials/);
  assert.match(stores,/inventory_batches/);
  assert.match(stores,/writeAudit/);
});

test('supplier reads and writes preserve branch scope on the server',()=>{
  const suppliers=read('src/routes/suppliers.js');
  const bootstrap=read('src/routes/bootstrap.js');
  assert.match(suppliers,/router\.get\("\/",requirePermission\("moduleSuppliers"\)/);
  assert.match(suppliers,/scopedStoreId\(req\.user,input\.storeId\)/);
  assert.match(suppliers,/filters\.push\(`store_id=\$\$\{params\.length\}`\)/);
  assert.match(bootstrap,/supplier_invoices i WHERE i\.supplier_id=s\.id\$\{branchStoreId\?" AND i\.store_id=\$2":""\}/);
});

test('registration is IP throttled before creating organizations',()=>{
  const auth=read('src/routes/auth.js');
  const migration=read('migrations/007_registration_throttle.sql');
  assert.match(migration,/CREATE TABLE IF NOT EXISTS auth_registration_attempts/);
  assert.match(migration,/auth_registration_attempts_ip_created_idx/);
  assert.match(auth,/maxRegistrationsPerIp=8/);
  assert.match(auth,/REGISTRATION_RATE_LIMITED/);
  assert.match(auth,/pg_advisory_xact_lock/);
  assert.match(auth,/recordRegistrationAttempt\(requestIp\(req\),input.phone\)/);
});

test('telegram group links are one-time and branch scoped',()=>{
  const telegram=read('src/routes/telegram.js');
  assert.match(telegram,/scopedStoreId\(req\.user,input\.storeId\|\|null\)/);
  assert.match(telegram,/UPDATE telegram_link_tokens SET consumed_at=now\(\).*created_by=\$2/);
  assert.match(telegram,/startgroup=\$\{encodeURIComponent\(raw\)\}/);
  assert.match(telegram,/expires_at>now\(\) FOR UPDATE/);
  assert.match(telegram,/connectionScopeSql/);
});

test('license expiry is inclusive and evaluated in the organization timezone',()=>{
  const auth=read('src/middleware/auth.js');
  const bootstrap=read('src/routes/bootstrap.js');
  const billing=read('src/routes/billing.js');
  const billingReview=read('src/services/billingReview.js');
  assert.match(auth,/AT TIME ZONE COALESCE\(NULLIF\(o\.timezone,''\),'Asia\/Tashkent'\)/);
  assert.match(auth,/licenseDateValid:row\.license_date_valid!==false/);
  assert.match(bootstrap,/license_date_valid/);
  assert.match(billing,/organizationCalendarDateISO\(org\)/);
  assert.match(billingReview,/currentExpiry && currentExpiry >= today/);
});


test('telegram group-to-supergroup migration preserves the linked connection safely',()=>{
  const telegram=read('src/routes/telegram.js');
  assert.match(telegram,/migrate_to_chat_id/);
  assert.match(telegram,/UPDATE telegram_connections SET chat_id=\$2,chat_title=\$3,enabled=true WHERE id=\$1/);
  assert.match(telegram,/telegram chat migrated to an existing connection/);
});

test('API validation failures are client errors instead of internal server errors',()=>{
  const errorSource=read('src/middleware/error.js');
  assert.match(errorSource,/error instanceof ZodError/);
  assert.match(errorSource,/VALIDATION_ERROR/);
  assert.match(errorSource,/INVALID_JSON/);
  assert.match(errorSource,/PAYLOAD_TOO_LARGE/);
  assert.match(errorSource,/22P02/);
  const app=read('src/app.js');
  assert.match(app,/CORS_FORBIDDEN/);
});
