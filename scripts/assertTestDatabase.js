import process from "node:process";
import { pathToFileURL } from "node:url";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TEST_DATABASE_MARKER = /(?:^|[_-])(test|testing|spec|ci|tmp)(?:[_-]|$)/i;
const CONNECTION_TARGET_OVERRIDES = new Set(["host", "hostaddr", "port", "dbname", "database", "service", "user", "password"]);

export const assertSafeTestDatabaseUrl = (value, {
  nodeEnv = process.env.NODE_ENV,
  allowRemote = false,
} = {}) => {
  if (nodeEnv === "production") throw new Error("Refusing database tests while NODE_ENV=production");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("TEST_DATABASE_URL must use the postgres or postgresql protocol");
  }
  if ([...parsed.searchParams.keys()].some((name) => CONNECTION_TARGET_OVERRIDES.has(name.toLowerCase()))) {
    throw new Error("TEST_DATABASE_URL must not contain a connection target override");
  }
  if (parsed.hostname.endsWith(".neon.tech")) throw new Error("Refusing to run database tests against Neon");
  if (!allowRemote && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("TEST_DATABASE_URL must use a loopback host unless explicitly overridden");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!TEST_DATABASE_MARKER.test(databaseName)) {
    throw new Error("TEST_DATABASE_URL database name must contain a test marker");
  }
  return parsed;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  console.log("[test-db] safety gate passed");
}
