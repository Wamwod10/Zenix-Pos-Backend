import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertDatabaseConnection } from "./startup.js";

export const REQUIRED_MIGRATIONS = Object.freeze([
  "001_initial.sql",
  "002_remove_trial_mode.sql",
  "003_notification_delivery_hardening.sql",
  "004_transfer_tracking.sql",
  "005_production_security.sql",
  "006_return_business_day.sql",
  "007_registration_throttle.sql",
  "008_serial_case_insensitive_unique.sql",
  "009_payment_telegram_approval.sql",
  "010_idempotency_and_billing_review.sql",
  "011_bootstrap_performance_indexes.sql",
  "012_customers_credit_sales.sql",
  "013_customer_credit_hardening.sql",
  "014_billing_checkout_schema.sql",
  "015_workspace_revisions.sql",
]);

export const REQUIRED_TABLES = Object.freeze([
  "schema_migrations",
  "organizations",
  "stores",
  "users",
  "auth_sessions",
  "user_preferences",
  "products",
  "inventory_balances",
  "inventory_batches",
  "product_serials",
  "stock_movements",
  "shifts",
  "shift_movements",
  "sales",
  "customers",
  "customer_ledger",
  "customer_payment_allocations",
  "customer_loyalty_ledger",
  "sale_items",
  "sale_payments",
  "sale_returns",
  "suppliers",
  "supplier_invoices",
  "supplier_payments",
  "supplier_invoice_items",
  "expenses",
  "stock_transfers",
  "stock_transfer_items",
  "inventory_counts",
  "sale_holds",
  "business_days",
  "billing_drafts",
  "billing_receipts",
  "billing_payments",
  "telegram_link_tokens",
  "telegram_connections",
  "notification_outbox",
  "notification_deliveries",
  "file_assets",
  "audit_logs",
  "auth_login_attempts",
  "auth_registration_attempts",
  "workspace_revisions",
]);

export const REQUIRED_FOREIGN_KEY_TABLES = Object.freeze([
  "stores",
  "users",
  "auth_sessions",
  "user_preferences",
  "products",
  "inventory_balances",
  "inventory_batches",
  "product_serials",
  "stock_movements",
  "shifts",
  "shift_movements",
  "sales",
  "customers",
  "customer_ledger",
  "customer_payment_allocations",
  "customer_loyalty_ledger",
  "sale_items",
  "sale_payments",
  "sale_returns",
  "suppliers",
  "supplier_invoices",
  "supplier_payments",
  "supplier_invoice_items",
  "expenses",
  "stock_transfers",
  "stock_transfer_items",
  "inventory_counts",
  "sale_holds",
  "business_days",
  "billing_drafts",
  "billing_receipts",
  "billing_payments",
  "telegram_link_tokens",
  "telegram_connections",
  "notification_outbox",
  "notification_deliveries",
  "file_assets",
  "audit_logs",
  "workspace_revisions",
]);

export const REQUIRED_UNIQUE_CONSTRAINT_TABLES = Object.freeze([
  "stores",
  "users",
  "auth_sessions",
  "product_serials",
  "sales",
  "customer_payment_allocations",
  "stock_transfer_items",
  "business_days",
  "billing_payments",
  "telegram_link_tokens",
  "telegram_connections",
  "notification_deliveries",
]);

export const REQUIRED_INDEXES = Object.freeze([
  "users_org_phone_unique",
  "users_username_global_unique",
  "auth_sessions_user_idx",
  "products_org_sku_unique",
  "products_org_barcode_unique",
  "products_org_active_idx",
  "inventory_batches_lookup_idx",
  "product_serials_lookup_idx",
  "stock_movements_lookup_idx",
  "shifts_open_register_unique",
  "sales_org_client_reference_unique",
  "sales_org_store_date_idx",
  "suppliers_org_phone_unique",
  "sale_holds_lookup_idx",
  "billing_draft_open_unique",
  "billing_draft_order_unique",
  "billing_receipts_org_idx",
  "notification_outbox_pending_idx",
  "file_assets_org_idx",
  "audit_logs_org_date_idx",
  "telegram_connections_chat_id_unique",
  "notification_deliveries_pending_idx",
  "notification_deliveries_outbox_idx",
  "product_serials_transfer_idx",
  "notification_outbox_org_event_unique",
  "auth_login_attempts_lookup_idx",
  "auth_login_attempts_cleanup_idx",
  "sale_returns_business_day_idx",
  "auth_registration_attempts_ip_created_idx",
  "product_serials_org_serial_ci_unique",
  "billing_payments_telegram_token_unique",
  "sale_returns_org_client_reference_unique",
  "billing_payments_one_review_per_type",
  "sale_returns_org_store_created_idx",
  "expenses_org_store_created_idx",
  "shifts_org_store_opened_idx",
  "shift_movements_shift_created_idx",
  "supplier_invoices_org_store_created_idx",
  "supplier_invoices_supplier_created_idx",
  "supplier_payments_org_store_created_idx",
  "supplier_payments_supplier_created_idx",
  "supplier_invoice_items_invoice_idx",
  "stock_transfers_org_created_idx",
  "inventory_counts_org_store_created_idx",
  "billing_payments_org_submitted_idx",
  "sale_items_product_sale_idx",
  "sale_payments_sale_idx",
  "sale_returns_sale_created_idx",
  "customer_payment_allocations_credit_idx",
  "customer_payment_allocations_customer_idx",
  "customer_loyalty_org_customer_idx",
]);

const missing = (required, actual) => {
  const actualSet = new Set(actual);
  return required.filter((name) => !actualSet.has(name));
};

export const findSchemaIssues = (snapshot) => {
  const checks = [
    ["missing tables", REQUIRED_TABLES, snapshot.tables],
    ["missing migration records", REQUIRED_MIGRATIONS, snapshot.migrations],
    ["missing primary keys on tables", REQUIRED_TABLES, snapshot.primaryKeyTables],
    ["missing foreign keys on tables", REQUIRED_FOREIGN_KEY_TABLES, snapshot.foreignKeyTables],
    ["missing unique constraints on tables", REQUIRED_UNIQUE_CONSTRAINT_TABLES, snapshot.uniqueConstraintTables],
    ["missing indexes", REQUIRED_INDEXES, snapshot.indexes],
  ];

  return checks.flatMap(([label, required, actual = []]) => {
    const names = missing(required, actual);
    return names.length ? [`${label}: ${names.join(", ")}`] : [];
  });
};

export const readDatabaseSchema = async (db) => {
  const [tables, migrations, primaryKeys, foreignKeys, uniqueConstraints, indexes] = await Promise.all([
    db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"),
    db.query("SELECT name FROM schema_migrations ORDER BY name"),
    db.query("SELECT table_name FROM information_schema.table_constraints WHERE table_schema='public' AND constraint_type='PRIMARY KEY'"),
    db.query("SELECT DISTINCT table_name FROM information_schema.table_constraints WHERE table_schema='public' AND constraint_type='FOREIGN KEY'"),
    db.query("SELECT DISTINCT table_name FROM information_schema.table_constraints WHERE table_schema='public' AND constraint_type='UNIQUE'"),
    db.query(`
      SELECT index_class.relname AS indexname
      FROM pg_class index_class
      JOIN pg_index index_row ON index_row.indexrelid=index_class.oid
      JOIN pg_namespace namespace ON namespace.oid=index_class.relnamespace
      WHERE namespace.nspname='public' AND index_row.indisvalid AND index_row.indisready
    `),
  ]);

  return {
    tables: tables.rows.map((row) => row.table_name),
    migrations: migrations.rows.map((row) => row.name),
    primaryKeyTables: primaryKeys.rows.map((row) => row.table_name),
    foreignKeyTables: foreignKeys.rows.map((row) => row.table_name),
    uniqueConstraintTables: uniqueConstraints.rows.map((row) => row.table_name),
    indexes: indexes.rows.map((row) => row.indexname),
  };
};

export const verifyDatabaseSchema = async (db) => {
  const snapshot = await readDatabaseSchema(db);
  const issues = findSchemaIssues(snapshot);
  if (issues.length) {
    throw new Error(`Database schema verification failed:\n- ${issues.join("\n- ")}`);
  }
  return snapshot;
};

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const { pool } = await import("./pool.js");
  try {
    const connection = await assertDatabaseConnection(pool);
    const snapshot = await verifyDatabaseSchema(pool);
    console.log(`[db:verify] OK database=${connection.database} tables=${snapshot.tables.length} migrations=${snapshot.migrations.length} indexes=${snapshot.indexes.length}`);
  } catch (error) {
    console.error(`[db:verify] ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
