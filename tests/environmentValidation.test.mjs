import test from "node:test";
import assert from "node:assert/strict";

import { parseRuntimeEnvironment } from "../src/config/env.js";
import { createMigrationPoolConfig, createPoolConfig } from "../src/db/config.js";

const developmentEnvironment = (overrides = {}) => ({
  NODE_ENV: "development",
  PORT: "4000",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/zenix",
  FRONTEND_ORIGIN: "http://localhost:5173",
  SESSION_TTL_DAYS: "30",
  PUBLIC_API_URL: "http://localhost:4000",
  ...overrides,
});

test("runtime environment parses bounded integer settings", () => {
  const parsed = parseRuntimeEnvironment(developmentEnvironment({
    PORT: "4100",
    SESSION_TTL_DAYS: "45",
    DB_CONNECTION_TIMEOUT_MS: "12000",
    DB_IDLE_TIMEOUT_MS: "45000",
    DB_STATEMENT_TIMEOUT_MS: "25000",
    DB_QUERY_TIMEOUT_MS: "30000",
    DB_IDLE_TX_TIMEOUT_MS: "10000",
  }));

  assert.equal(parsed.port, 4100);
  assert.equal(parsed.sessionTtlDays, 45);
  assert.equal(parsed.databaseConnectionTimeoutMs, 12000);
  assert.equal(parsed.databaseIdleTimeoutMs, 45000);
  assert.equal(parsed.databaseStatementTimeoutMs, 25000);
  assert.equal(parsed.databaseQueryTimeoutMs, 30000);
  assert.equal(parsed.databaseIdleTransactionTimeoutMs, 10000);
});

test("runtime environment rejects malformed and out-of-range integers", () => {
  for (const PORT of ["0", "65536", "4.5", "port"]) {
    assert.throws(() => parseRuntimeEnvironment(developmentEnvironment({ PORT })), /PORT must be an integer between 1 and 65535/);
  }
  for (const SESSION_TTL_DAYS of ["0", "366", "1.5", "days"]) {
    assert.throws(() => parseRuntimeEnvironment(developmentEnvironment({ SESSION_TTL_DAYS })), /SESSION_TTL_DAYS must be an integer between 1 and 365/);
  }
});

test("frontend origins must be exact HTTP origins", () => {
  const parsed = parseRuntimeEnvironment(developmentEnvironment({
    FRONTEND_ORIGIN: "http://localhost:5173/, https://example.com",
  }));
  assert.deepEqual(parsed.frontendOrigins, ["http://localhost:5173", "https://example.com"]);

  for (const FRONTEND_ORIGIN of [
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com/app",
    "https://example.com?preview=1",
  ]) {
    assert.throws(() => parseRuntimeEnvironment(developmentEnvironment({ FRONTEND_ORIGIN })), /FRONTEND_ORIGIN/);
  }
});

test("production public URLs and frontend origins require HTTPS", () => {
  const production = developmentEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/db?sslmode=require",
    FRONTEND_ORIGIN: "https://pos.example.com",
    PUBLIC_API_URL: "https://api.example.com",
  });
  assert.equal(parseRuntimeEnvironment(production).publicApiUrl, "https://api.example.com");
  assert.throws(() => parseRuntimeEnvironment({ ...production, FRONTEND_ORIGIN: "http://pos.example.com" }), /FRONTEND_ORIGIN must use HTTPS/);
  assert.throws(() => parseRuntimeEnvironment({ ...production, PUBLIC_API_URL: "http://api.example.com" }), /PUBLIC_API_URL must use HTTPS/);
});

test("pool configuration validates and applies database timeouts", () => {
  const config = createPoolConfig({
    databaseUrl: "postgresql://postgres:postgres@localhost:5432/zenix",
    poolMax: "8",
    connectionTimeoutMs: 12000,
    idleTimeoutMs: 45000,
    statementTimeoutMs: 25000,
    queryTimeoutMs: 30000,
    idleTransactionTimeoutMs: 10000,
  });
  assert.equal(config.max, 8);
  assert.equal(config.connectionTimeoutMillis, 12000);
  assert.equal(config.idleTimeoutMillis, 45000);
  assert.equal(config.statement_timeout, 25000);
  assert.equal(config.query_timeout, 30000);
  assert.equal(config.idle_in_transaction_session_timeout, 10000);

  assert.throws(() => createPoolConfig({ connectionTimeoutMs: 0 }), /DB_CONNECTION_TIMEOUT_MS/);
  assert.throws(() => createPoolConfig({ statementTimeoutMs: "later" }), /DB_STATEMENT_TIMEOUT_MS/);
});

test("production migrations require a direct Neon endpoint", () => {
  const direct = "postgresql://user:secret@ep-example.us-east-2.aws.neon.tech/db?sslmode=require";
  const pooled = "postgresql://user:secret@ep-example-pooler.us-east-2.aws.neon.tech/db?sslmode=require";
  assert.equal(createMigrationPoolConfig({ databaseUrl: direct, isProduction: true }).max, 1);
  assert.throws(() => createMigrationPoolConfig({ databaseUrl: pooled, isProduction: true }), /direct Neon endpoint/);
  assert.throws(() => createMigrationPoolConfig({ isProduction: true }), /MIGRATION_DATABASE_URL/);
});

test("runtime environment keeps migration and application database URLs separate", () => {
  const parsed = parseRuntimeEnvironment(developmentEnvironment({
    MIGRATION_DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/zenix_migration_test",
  }));
  assert.match(parsed.migrationDatabaseUrl, /zenix_migration_test/);
});
