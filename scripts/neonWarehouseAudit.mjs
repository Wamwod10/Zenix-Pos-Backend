import { randomBytes } from 'node:crypto';
import { run } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { assertSafeTestDatabaseUrl } from './assertTestDatabase.js';

// This capability exists only in this process after API verification; environment
// variables alone cannot bypass the normal local-only test gate.
let verifiedUrl;
export function assertDisposableNeonBranch(branch, { id, name }) {
  if (!branch || branch.id !== id || branch.name !== name || !/^warehouse-audit-test-[a-f0-9]{24}$/.test(name) || branch.default !== false || branch.protected !== false || !branch.parent_id) {
    throw new Error('Disposable Neon branch verification failed');
  }
}
export function assertNeonEndpointUri(value, endpoint, database) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !endpoint.host?.endsWith('.neon.tech') || url.hostname !== endpoint.host || decodeURIComponent(url.pathname.slice(1)) !== database.name || decodeURIComponent(url.username) !== database.owner_name || (url.port && url.port !== '5432')) throw new Error('API connection URI mismatch');
  const safeParameters = new Set(['sslmode', 'channel_binding']);
  if ([...url.searchParams.keys()].some(param => !safeParameters.has(param)) || url.searchParams.get('sslmode') !== 'require') throw new Error('Unsafe API connection parameters');
  return url;
}
export function assertWarehouseAuditDatabaseUrl(value, options = {}) {
  if (!verifiedUrl) return assertSafeTestDatabaseUrl(value, options);
  if ((options.nodeEnv || process.env.NODE_ENV) === 'production') throw new Error('Production test environment refused');
  const parsed = new URL(value);
  const expected = new URL(verifiedUrl);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (parsed.pathname !== expected.pathname && !/^warehouse_audit_test_[a-f0-9]{24}$/.test(database)) {
    throw new Error('Unapproved warehouse audit database');
  }
  parsed.pathname = expected.pathname;
  if (parsed.href !== expected.href) throw new Error('Unapproved warehouse audit connection target');
  return new URL(value);
}

export async function runNeonWarehouseAudit() {
  if (process.env.NODE_ENV === 'production') throw new Error('Production test environment refused');
  const key = process.env.NEON_API_KEY;
  const project = process.env.NEON_PROJECT_ID;
  if (!key || !/^[a-z0-9-]{1,60}$/.test(project || '')) throw new Error('NEON_API_KEY and valid NEON_PROJECT_ID required');
  const base = `https://console.neon.tech/api/v2/projects/${project}`;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Neon API ${method} failed (${response.status})`);
    return response.status === 204 ? {} : response.json();
  };
  const waitOperations = async operations => {
    const deadline = Date.now() + 120000;
    for (const operation of operations || []) {
      if (!/^[a-f0-9-]{36}$/.test(operation.id || '')) throw new Error('Invalid Neon operation identity');
      while (true) {
        const current = (await api(`/operations/${operation.id}`)).operation;
        if (current?.id !== operation.id) throw new Error('Neon operation identity mismatch');
        if (current.status === 'finished') break;
        if (['failed', 'error', 'cancelled'].includes(current.status) || Date.now() >= deadline) throw new Error('Neon operation failed or timed out');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  };
  const name = `warehouse-audit-test-${randomBytes(12).toString('hex')}`;
  let ownedId;
  const previousUrl = process.env.TEST_DATABASE_URL;
  const previousEnv = process.env.NODE_ENV;
  const checkBranch = branch => {
    assertDisposableNeonBranch(branch, { id: ownedId, name });
  };
  try {
    const created = await api('/branches', 'POST', { branch: { name, protected: false }, endpoints: [{ type: 'read_write' }] });
    if (!/^br-[a-z0-9-]+$/.test(created.branch?.id || '') || created.branch.name !== name) {
      throw new Error('Neon branch creation identity invalid; inspect API console for an orphan test branch');
    }
    ownedId = created.branch.id;
    await waitOperations(created.operations);
    checkBranch((await api(`/branches/${ownedId}`)).branch);
    const endpoints = (await api(`/branches/${ownedId}/endpoints`)).endpoints;
    const endpoint = endpoints?.find(item => item.branch_id === ownedId && item.type === 'read_write');
    if (!endpoint || !/^ep-[a-z0-9-]+$/.test(endpoint.id) || !endpoint.host?.endsWith('.neon.tech')) throw new Error('Disposable endpoint verification failed');
    const confirmed = (await api(`/endpoints/${endpoint.id}`)).endpoint;
    if (confirmed?.branch_id !== ownedId || confirmed.id !== endpoint.id || confirmed.host !== endpoint.host) throw new Error('Endpoint identity mismatch');
    const databases = (await api(`/branches/${ownedId}/databases`)).databases;
    const database = databases?.find(item => item.branch_id === ownedId && item.owner_name && item.name);
    if (!database) throw new Error('Cloned database owner unavailable');
    const query = new URLSearchParams({ branch_id: ownedId, endpoint_id: endpoint.id, database_name: database.name, role_name: database.owner_name, pooled: 'false' });
    const uri = (await api(`/connection_uri?${query}`)).uri;
    const url = assertNeonEndpointUri(uri, endpoint, database);
    verifiedUrl = url.href;
    process.env.TEST_DATABASE_URL = verifiedUrl;
    process.env.NODE_ENV = 'test';
    let failures = 0, passes = 0;
    const stream = run({ files: [fileURLToPath(new URL('../tests/warehouseMigrationAudit.test.mjs', import.meta.url))], isolation: 'none', concurrency: false });
    for await (const event of stream) {
      if (event.type === 'test:pass') { passes++; console.log(`PASS ${event.data.name}`); }
      if (event.type === 'test:fail') { failures++; console.error(`FAIL ${event.data.name}`); }
    }
    if (failures || !passes) throw new Error(`Warehouse Neon tests failed (${failures} failures, ${passes} passes)`);
    console.log(`Warehouse Neon audit passed (${passes} tests)`);
  } finally {
    verifiedUrl = undefined;
    if (previousUrl === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = previousUrl;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    if (ownedId) {
      checkBranch((await api(`/branches/${ownedId}`)).branch);
      const deleted = await api(`/branches/${ownedId}`, 'DELETE');
      await waitOperations(deleted.operations);
      console.log('Disposable Neon audit branch deleted');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
  if (!process.env.NEON_API_KEY || !/^[a-z0-9-]{1,60}$/.test(process.env.NEON_PROJECT_ID || '')) {
    console.error('Set NEON_API_KEY and valid NEON_PROJECT_ID in backend/.env or this process environment.');
    process.exitCode = 1;
  } else {
    runNeonWarehouseAudit().catch(() => { console.error('Neon warehouse audit failed; no credentials logged. Check branch cleanup in Neon console if deletion was not confirmed.'); process.exitCode = 1; });
  }
}
