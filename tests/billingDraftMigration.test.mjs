import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("billing checkout schema is repaired by an additive migration", async () => {
  const migrationName = "014_billing_checkout_schema.sql";
  const migrationPath = path.join(root, "migrations", migrationName);

  assert.equal(fs.existsSync(migrationPath), true, `${migrationName} must exist`);

  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_drafts/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS billing_receipts/i);
  assert.match(sql, /ALTER TABLE billing_payments/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS draft_id/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS receipt_id/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS billing_draft_open_unique/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS billing_draft_order_unique/i);

  const schema = await import("../src/db/verifySchema.js");
  assert.ok(schema.REQUIRED_MIGRATIONS.includes(migrationName));
});
