import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadMigrationCatalog } from "../src/db/migrationCatalog.js";

const auditModule=await import("../src/db/auditIntegrity.js").catch(()=>({}));
const schemaModule=await import("../src/db/verifySchema.js").catch(()=>({}));

test("MVP18 migrations separate transactional tables from concurrent indexes and guarded constraints", async () => {
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const catalog = await loadMigrationCatalog(directory);
  const tables = catalog.find(({ name }) => name === "020_extra_store_entitlements.sql");
  const indexes = catalog.find(({ name }) => name === "021_mvp18_concurrent_indexes.sql");
  const constraints = catalog.find(({ name }) => name === "022_mvp18_guarded_constraints.sql");
  assert.equal(tables.transactional, true);
  assert.doesNotMatch(tables.sql, /CREATE\s+(?:UNIQUE\s+)?INDEX\b|ADD\s+CONSTRAINT/i);
  assert.ok(indexes, "concurrent migration 021 must exist");
  assert.equal(indexes.transactional, false);
  assert.ok(indexes.sql.startsWith("-- migrate:no-transaction"));
  for (const name of ["extra_store_entitlements_active_idx", "billing_payments_org_id_unique"]) {
    assert.match(indexes.sql, new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+CONCURRENTLY\\s+IF\\s+NOT\\s+EXISTS\\s+${name}\\b`, "i"));
  }
  assert.ok(constraints, "guarded constraint migration 022 must exist");
  assert.equal(constraints.transactional, true);
  assert.match(constraints.sql, /pg_constraint/i);
  assert.match(constraints.sql, /conrelid\s*=\s*'extra_store_entitlements'::regclass/i);
  assert.match(constraints.sql, /ADD CONSTRAINT extra_store_entitlements_payment_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(constraints.sql, /VALIDATE CONSTRAINT extra_store_entitlements_payment_tenant_fk/i);
  assert.deepEqual(await loadMigrationCatalog(directory), catalog);
});

test("schema verification reports missing MVP18 migration records and invalid final objects", () => {
  const snapshot = {
    tables: schemaModule.REQUIRED_TABLES,
    migrations: schemaModule.REQUIRED_MIGRATIONS.filter(name => !name.startsWith("021_") && !name.startsWith("022_")),
    primaryKeyTables: schemaModule.REQUIRED_TABLES,
    foreignKeyTables: schemaModule.REQUIRED_FOREIGN_KEY_TABLES,
    uniqueConstraintTables: schemaModule.REQUIRED_UNIQUE_CONSTRAINT_TABLES,
    indexes: schemaModule.REQUIRED_INDEXES.filter(name => name !== "billing_payments_org_id_unique"),
    tenantConstraints: schemaModule.REQUIRED_TENANT_CONSTRAINTS.filter(name => name !== "extra_store_entitlements_payment_tenant_fk"),
  };
  assert.deepEqual(schemaModule.findSchemaIssues(snapshot), [
    "missing migration records: 021_mvp18_concurrent_indexes.sql, 022_mvp18_guarded_constraints.sql",
    "missing indexes: billing_payments_org_id_unique",
    "missing tenant integrity constraints: extra_store_entitlements_payment_tenant_fk",
  ]);
});

test("tenant integrity migration is additive and guards high-risk relationships", async () => {
  const sql=await fs.readFile(new URL("../migrations/016_tenant_integrity_guards.sql",import.meta.url),"utf8").catch(()=>"");
  assert.ok(sql,"migration 016 must exist");
  assert.doesNotMatch(sql,/\b(?:DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/i);
  assert.match(sql,/inventory_balances_store_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/sales_store_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/sale_returns_sale_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/supplier_invoices_supplier_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/customer_ledger_customer_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/stock_transfers_from_store_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/billing_drafts_created_by_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/telegram_connections_store_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/notification_outbox_store_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/file_assets_uploaded_by_tenant_fk[\s\S]*NOT VALID/i);
  assert.match(sql,/audit_logs_store_tenant_fk[\s\S]*NOT VALID/i);
});

test("schema verification requires migration 016 and its tenant constraints", () => {
  assert.ok(schemaModule.REQUIRED_MIGRATIONS?.includes("016_tenant_integrity_guards.sql"));
  for(const name of [
    "inventory_balances_store_tenant_fk",
    "sales_store_tenant_fk",
    "customer_ledger_customer_tenant_fk",
    "stock_transfers_from_store_tenant_fk",
  ])assert.ok(schemaModule.REQUIRED_TENANT_CONSTRAINTS?.includes(name),`missing ${name}`);
});

test("every tenant foreign key in migration 016 is covered by the integrity audit catalog", async () => {
  const sources=await Promise.all([
    "../migrations/016_tenant_integrity_guards.sql",
    "../migrations/022_mvp18_guarded_constraints.sql",
  ].map(name=>fs.readFile(new URL(name,import.meta.url),"utf8")));
  const sql=sources.join("\n");
  const migrationConstraints=[...sql.matchAll(/ADD CONSTRAINT\s+(\w+_tenant_fk)\s+FOREIGN KEY/gi)].map((match)=>match[1]);
  assert.deepEqual(new Set(schemaModule.REQUIRED_TENANT_CONSTRAINTS),new Set(migrationConstraints));
});

test("tenant integrity audit is read-only and returns named numeric counts", async () => {
  assert.equal(typeof auditModule.auditTenantIntegrity,"function");
  const queries=[];
  const metadata=schemaModule.REQUIRED_TENANT_CONSTRAINTS.map((constraint_name)=>({
    constraint_name,
    child_table:"child_table",
    parent_table:"parent_table",
    child_columns:["organization_id","parent_id"],
    parent_columns:["organization_id","id"],
  }));
  const db={query:async(sql)=>{
    queries.push(String(sql));
    if(queries.length===1)return {rows:metadata};
    return {rows:metadata.map(({constraint_name},index)=>({check_name:constraint_name,violations:index===0?"2":"0"}))};
  }};
  const result=await auditModule.auditTenantIntegrity(db);
  assert.equal(Object.keys(result).length,schemaModule.REQUIRED_TENANT_CONSTRAINTS.length);
  assert.equal(result[schemaModule.REQUIRED_TENANT_CONSTRAINTS[0]],2);
  assert.equal(queries.length,2);
  for(const query of queries){
    assert.match(query,/^\s*SELECT/i);
    assert.doesNotMatch(query,/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
  }
});
