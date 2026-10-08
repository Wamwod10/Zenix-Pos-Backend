import pg from "pg";
import { env } from "../config/env.js";
import { createMigrationPoolConfig } from "./config.js";

const { Pool } = pg;
export const migrationPool = new Pool(createMigrationPoolConfig({
  databaseUrl: env.migrationDatabaseUrl,
  isProduction: env.isProduction,
  connectionTimeoutMs: env.databaseConnectionTimeoutMs,
  idleTimeoutMs: env.databaseIdleTimeoutMs,
  statementTimeoutMs: env.databaseStatementTimeoutMs,
  queryTimeoutMs: env.databaseQueryTimeoutMs,
  idleTransactionTimeoutMs: env.databaseIdleTransactionTimeoutMs,
}));

migrationPool.on("error", (error) => console.error("[migration-db] idle client error", error));
