import pg from "pg";
import { env } from "../config/env.js";
import { createPoolConfig } from "./config.js";
import {performanceMetrics} from '../lib/performanceMetrics.js';
import {instrumentPool} from './performance.js';

const { Pool } = pg;
export const pool = new Pool(createPoolConfig({
  databaseUrl: env.databaseUrl,
  isProduction: env.isProduction,
  poolMax: env.databasePoolMax,
  connectionTimeoutMs: env.databaseConnectionTimeoutMs,
  idleTimeoutMs: env.databaseIdleTimeoutMs,
  statementTimeoutMs: env.databaseStatementTimeoutMs,
  queryTimeoutMs: env.databaseQueryTimeoutMs,
  idleTransactionTimeoutMs: env.databaseIdleTransactionTimeoutMs,
}));

pool.on("error", (error) => console.error("[db] idle client error", error));
instrumentPool(pool,performanceMetrics);
