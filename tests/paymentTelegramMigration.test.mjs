import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("payment Telegram migration is additive and indexes opaque callback hashes", () => {
  const sql = fs.readFileSync(path.join(root, "migrations/009_payment_telegram_approval.sql"), "utf8");
  assert.match(sql, /ALTER TABLE billing_payments/);
  for (const column of [
    "telegram_review_token_hash",
    "telegram_review_token_expires_at",
    "telegram_admin_chat_id",
    "telegram_admin_message_id",
    "telegram_notification_sent_at",
  ]) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_telegram_token_unique/);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*(payments|subscriptions)/i);
});

test("schema verifier requires the payment approval migration and token index", async () => {
  const schema = await import("../src/db/verifySchema.js");
  assert.ok(schema.REQUIRED_MIGRATIONS.includes("009_payment_telegram_approval.sql"));
  assert.ok(schema.REQUIRED_INDEXES.includes("billing_payments_telegram_token_unique"));
});
