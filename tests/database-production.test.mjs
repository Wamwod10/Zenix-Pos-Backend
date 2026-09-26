import test from "node:test";
import assert from "node:assert/strict";

const configModule = await import("../src/db/config.js").catch(() => ({}));
const startupModule = await import("../src/db/startup.js").catch(() => ({}));
const schemaModule = await import("../src/db/verifySchema.js").catch(() => ({}));
const envModule = await import("../src/config/env.js").catch(() => ({}));

const pooledUrl = "postgresql://user:password@ep-example-pooler.eu-central-1.aws.neon.tech/app?sslmode=require&channel_binding=require";

test("production database config accepts a pooled Neon TLS URL with a small default pool", () => {
  assert.equal(typeof configModule.createPoolConfig, "function");
  const config = configModule.createPoolConfig({
    databaseUrl: pooledUrl,
    isProduction: true,
  });

  assert.equal(config.connectionString, pooledUrl);
  assert.equal(config.max, 5);
  assert.equal(config.enableChannelBinding, true);
  assert.equal(Object.hasOwn(config, "ssl"), false);
});

test("production database config rejects direct Neon endpoints", () => {
  assert.equal(typeof configModule.createPoolConfig, "function");
  assert.throws(
    () => configModule.createPoolConfig({
      databaseUrl: "postgresql://user:password@ep-example.eu-central-1.aws.neon.tech/app?sslmode=require",
      isProduction: true,
    }),
    /pooled Neon endpoint/i,
  );
});

test("production database config rejects connections without required TLS", () => {
  assert.equal(typeof configModule.createPoolConfig, "function");
  assert.throws(
    () => configModule.createPoolConfig({
      databaseUrl: "postgresql://user:password@ep-example-pooler.eu-central-1.aws.neon.tech/app",
      isProduction: true,
    }),
    /sslmode=require/i,
  );
});

test("database pool limit must stay within the Render-safe range", () => {
  assert.equal(typeof configModule.createPoolConfig, "function");
  for (const poolMax of ["0", "21", "2.5", "many"]) {
    assert.throws(
      () => configModule.createPoolConfig({
        databaseUrl: pooledUrl,
        isProduction: true,
        poolMax,
      }),
      /DB_POOL_MAX must be an integer between 1 and 20/,
    );
  }

  assert.equal(configModule.createPoolConfig({
    databaseUrl: pooledUrl,
    isProduction: true,
    poolMax: "8",
  }).max, 8);
});

test("startup database failures are actionable without leaking credentials", async () => {
  assert.equal(typeof startupModule.assertDatabaseConnection, "function");
  const secret = "postgresql://owner:do-not-print@ep-example-pooler.neon.tech/app";
  const db = {
    query: async () => {
      throw new Error(`connection refused for ${secret}`);
    },
  };

  await assert.rejects(
    startupModule.assertDatabaseConnection(db),
    (error) => {
      assert.match(error.message, /Database connection failed/);
      assert.match(error.message, /DATABASE_URL/);
      assert.doesNotMatch(error.message, /do-not-print/);
      assert.ok(error.cause);
      return true;
    },
  );
});

test("startup database probe succeeds only after PostgreSQL answers", async () => {
  assert.equal(typeof startupModule.assertDatabaseConnection, "function");
  const queries = [];
  const result = await startupModule.assertDatabaseConnection({
    query: async (sql) => {
      queries.push(sql);
      return { rows: [{ database: "app", user_name: "owner" }] };
    },
  });

  assert.deepEqual(queries, ["SELECT current_database() AS database, current_user AS user_name"]);
  assert.deepEqual(result, { database: "app", userName: "owner" });
});

test("production server variables are validated at server startup instead of migration import time", () => {
  assert.equal(typeof envModule.assertServerEnvironment, "function");
  assert.doesNotThrow(() => envModule.assertServerEnvironment({ isProduction: false }));
  assert.throws(
    () => envModule.assertServerEnvironment({
      isProduction: true,
      frontendOrigins: [],
      telegramBotToken: "",
      telegramWebhookSecret: "",
      publicApiUrl: "",
    }),
    /FRONTEND_ORIGIN, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_API_URL are required/,
  );
});

test("schema verification covers all migrations and core backend domains", () => {
  assert.equal(typeof schemaModule.findSchemaIssues, "function");
  assert.deepEqual(schemaModule.REQUIRED_MIGRATIONS, [
    "001_initial.sql",
    "002_remove_trial_mode.sql",
    "003_notification_delivery_hardening.sql",
    "004_transfer_tracking.sql",
    "005_production_security.sql",
    "006_return_business_day.sql",
    "007_registration_throttle.sql",
    "008_serial_case_insensitive_unique.sql",
  ]);

  for (const table of [
    "organizations", "users", "stores", "products", "inventory_balances",
    "sales", "shifts", "suppliers", "expenses", "billing_payments",
    "telegram_connections", "notification_deliveries", "auth_sessions",
  ]) {
    assert.ok(schemaModule.REQUIRED_TABLES.includes(table), `missing required table definition: ${table}`);
  }

  const complete = {
    tables: [...schemaModule.REQUIRED_TABLES],
    migrations: [...schemaModule.REQUIRED_MIGRATIONS],
    primaryKeyTables: [...schemaModule.REQUIRED_TABLES],
    foreignKeyTables: [...schemaModule.REQUIRED_FOREIGN_KEY_TABLES],
    uniqueConstraintTables: [...schemaModule.REQUIRED_UNIQUE_CONSTRAINT_TABLES],
    indexes: [...schemaModule.REQUIRED_INDEXES],
  };
  assert.deepEqual(schemaModule.findSchemaIssues(complete), []);

  const incomplete = {
    ...complete,
    tables: complete.tables.filter((name) => name !== "sales"),
    foreignKeyTables: complete.foreignKeyTables.filter((name) => name !== "sale_items"),
    uniqueConstraintTables: complete.uniqueConstraintTables.filter((name) => name !== "users"),
    indexes: complete.indexes.filter((name) => name !== "products_org_sku_unique"),
    migrations: complete.migrations.filter((name) => name !== "008_serial_case_insensitive_unique.sql"),
  };
  const issues = schemaModule.findSchemaIssues(incomplete).join("\n");
  assert.match(issues, /missing tables: sales/);
  assert.match(issues, /missing migration records: 008_serial_case_insensitive_unique.sql/);
  assert.match(issues, /missing foreign keys on tables: sale_items/);
  assert.match(issues, /missing unique constraints on tables: users/);
  assert.match(issues, /missing indexes: products_org_sku_unique/);
});
