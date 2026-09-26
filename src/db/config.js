const DEFAULT_POOL_MAX = 5;
const MAX_POOL_MAX = 20;
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

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

export const createPoolConfig = ({ databaseUrl, isProduction = false, poolMax } = {}) => {
  const parsedUrl = parseDatabaseUrl(databaseUrl, isProduction);
  const config = {
    connectionString: databaseUrl || undefined,
    max: parsePoolMax(poolMax),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };

  if (isProduction) {
    config.enableChannelBinding = true;
  } else if (!parsedUrl?.searchParams.has("sslmode")) {
    config.ssl = false;
  }

  return config;
};
