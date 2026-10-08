const DEFAULT_POOL_MAX = 5;
const MAX_POOL_MAX = 20;
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

const parseTimeout = (value, name, fallback, maximum) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1000 and ${maximum}`);
  }
  return parsed;
};

const parsePoolMax = (value) => {
  const parsed = Number(value ?? DEFAULT_POOL_MAX);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_POOL_MAX) {
    throw new Error(`DB_POOL_MAX must be an integer between 1 and ${MAX_POOL_MAX}`);
  }
  return parsed;
};

const parseDatabaseUrl = (databaseUrl, isProduction) => {
  if (!databaseUrl) {
    if (isProduction) throw new Error("DATABASE_URL is required in production");
    return null;
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }

  if (isProduction) {
    if (!parsed.hostname.endsWith(".neon.tech") || !parsed.hostname.split(".")[0].endsWith("-pooler")) {
      throw new Error("DATABASE_URL must use a pooled Neon endpoint (-pooler hostname) in production");
    }
    if (!TLS_MODES.has(parsed.searchParams.get("sslmode"))) {
      throw new Error("DATABASE_URL must include sslmode=require (or a stricter verify mode) in production");
    }
  }

  return parsed;
};

export const createPoolConfig = ({
  databaseUrl,
  isProduction = false,
  poolMax,
  connectionTimeoutMs,
  idleTimeoutMs,
  statementTimeoutMs,
  queryTimeoutMs,
  idleTransactionTimeoutMs,
} = {}) => {
  const parsedUrl = parseDatabaseUrl(databaseUrl, isProduction);
  const config = {
    connectionString: databaseUrl || undefined,
    max: parsePoolMax(poolMax),
    idleTimeoutMillis: parseTimeout(idleTimeoutMs, "DB_IDLE_TIMEOUT_MS", 30_000, 300_000),
    connectionTimeoutMillis: parseTimeout(connectionTimeoutMs, "DB_CONNECTION_TIMEOUT_MS", 10_000, 60_000),
    statement_timeout: parseTimeout(statementTimeoutMs, "DB_STATEMENT_TIMEOUT_MS", 30_000, 120_000),
    query_timeout: parseTimeout(queryTimeoutMs, "DB_QUERY_TIMEOUT_MS", 35_000, 180_000),
    idle_in_transaction_session_timeout: parseTimeout(idleTransactionTimeoutMs, "DB_IDLE_TX_TIMEOUT_MS", 15_000, 120_000),
  };

  if (isProduction) {
    config.enableChannelBinding = true;
  } else if (!parsedUrl?.searchParams.has("sslmode")) {
    config.ssl = false;
  }

  return config;
};

export const createMigrationPoolConfig = ({
  databaseUrl,
  isProduction = false,
  connectionTimeoutMs,
  idleTimeoutMs,
  statementTimeoutMs,
  queryTimeoutMs,
  idleTransactionTimeoutMs,
} = {}) => {
  if (!databaseUrl && isProduction) throw new Error("MIGRATION_DATABASE_URL is required in production");
  const parsedUrl = parseDatabaseUrl(databaseUrl, false);
  if (isProduction) {
    if (!parsedUrl.hostname.endsWith(".neon.tech") || parsedUrl.hostname.split(".")[0].endsWith("-pooler")) {
      throw new Error("MIGRATION_DATABASE_URL must use a direct Neon endpoint in production");
    }
    if (!TLS_MODES.has(parsedUrl.searchParams.get("sslmode"))) {
      throw new Error("MIGRATION_DATABASE_URL must include sslmode=require (or a stricter verify mode) in production");
    }
  }
  return {
    connectionString: databaseUrl || undefined,
    max: 1,
    idleTimeoutMillis: parseTimeout(idleTimeoutMs, "DB_IDLE_TIMEOUT_MS", 30_000, 300_000),
    connectionTimeoutMillis: parseTimeout(connectionTimeoutMs, "DB_CONNECTION_TIMEOUT_MS", 10_000, 60_000),
    statement_timeout: parseTimeout(statementTimeoutMs, "DB_STATEMENT_TIMEOUT_MS", 30_000, 120_000),
    query_timeout: parseTimeout(queryTimeoutMs, "DB_QUERY_TIMEOUT_MS", 35_000, 180_000),
    idle_in_transaction_session_timeout: parseTimeout(idleTransactionTimeoutMs, "DB_IDLE_TX_TIMEOUT_MS", 15_000, 120_000),
    ...(isProduction ? { enableChannelBinding: true } : parsedUrl?.searchParams.has("sslmode") ? {} : { ssl: false }),
  };
};
