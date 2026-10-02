import test from "node:test";
import assert from "node:assert/strict";

import * as customerRoute from "../src/routes/customers.js";
import { app } from "../src/app.js";
import { pool } from "../src/db/pool.js";

test("customer PATCH preserves fields omitted by the client", () => {
  const patch = customerRoute.parseCustomerPatch({ name: "  Yangi ism  " });

  assert.deepEqual(patch, { name: "Yangi ism" });
});

test("customer API rejects an authenticated user without moduleSales permission", async (t) => {
  const originalQuery = pool.query;
  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    return { rows: [{
      session_id: "session-1",
      expires_at: new Date(Date.now() + 60_000),
      last_seen_at: new Date(),
      id: "user-1",
      organization_id: "organization-1",
      store_id: null,
      name: "Omborchi",
      username: "warehouse",
      phone: "",
      app_role: "WAREHOUSE",
      permission_overrides: {},
      active: true,
      organization_name: "Test",
      license_status: "ACTIVE",
      expiry_date: null,
      organization_timezone: "Asia/Tashkent",
      license_date_valid: true,
      organization_settings: {},
    }] };
  };

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => {
    pool.query = originalQuery;
    server.close();
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/customers/stats`, {
    headers: { cookie: "zenix_session=test-session" },
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error?.code, "FORBIDDEN");
  assert.equal(queryCount, 1);
});

test("customer payment rejects a store outside the authenticated user's scope", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  let transactionStarted = false;
  pool.query = async () => ({ rows: [{
    session_id: "session-2",
    expires_at: new Date(Date.now() + 60_000),
    last_seen_at: new Date(),
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: "00000000-0000-4000-8000-000000000002",
    store_id: "00000000-0000-4000-8000-000000000003",
    name: "Kassir",
    username: "cashier",
    phone: "",
    app_role: "CASHIER",
    permission_overrides: {},
    active: true,
    organization_name: "Test",
    license_status: "ACTIVE",
    expiry_date: null,
    organization_timezone: "Asia/Tashkent",
    license_date_valid: true,
    organization_settings: {},
  }] });
  pool.connect = async () => {
    transactionStarted = true;
    throw new Error("Transaction must not start for an out-of-scope store");
  };

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    server.close();
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/customers/00000000-0000-4000-8000-000000000004/payments`, {
    method: "POST",
    headers: { cookie: "zenix_session=test-session", "content-type": "application/json", origin: "http://localhost:5173", "x-zenix-client": "web" },
    body: JSON.stringify({ amount: 10_000, paymentMethod: "cash", storeId: "00000000-0000-4000-8000-000000000005" }),
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.error?.code, "STORE_FORBIDDEN");
  assert.equal(transactionStarted, false);
});

test("customer payment derives the assigned store when a branch user omits storeId", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const assignedStoreId = "00000000-0000-4000-8000-000000000003";
  let insertedStoreId = null;
  pool.query = async () => ({ rows: [{
    session_id: "session-3",
    expires_at: new Date(Date.now() + 60_000),
    last_seen_at: new Date(),
    id: "00000000-0000-4000-8000-000000000001",
    organization_id: "00000000-0000-4000-8000-000000000002",
    store_id: assignedStoreId,
    name: "Kassir",
    username: "cashier",
    phone: "",
    app_role: "CASHIER",
    permission_overrides: {},
    active: true,
    organization_name: "Test",
    license_status: "ACTIVE",
    expiry_date: null,
    organization_timezone: "Asia/Tashkent",
    license_date_valid: true,
    organization_settings: {},
  }] });
  const client = {
    async query(sql, params = []) {
      if (/SELECT id,name,active FROM stores/.test(sql)) return { rows: [{ id: assignedStoreId, name: "Filial", active: true }] };
      if (/SELECT \* FROM customers/.test(sql)) return { rows: [{ id: "00000000-0000-4000-8000-000000000004", name: "Mijoz" }] };
      if (/SELECT COALESCE\(sum\(amount\),0\) balance/.test(sql)) return { rows: [{ balance: "20000" }] };
      if (/INSERT INTO customer_ledger/.test(sql)) {
        insertedStoreId = params[2];
        return { rows: [{ id: "00000000-0000-4000-8000-000000000006", amount: "-10000", payment_method: "cash", created_at: new Date() }] };
      }
      if (/SELECT cl\.id,GREATEST/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  pool.connect = async () => client;

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    server.close();
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/customers/00000000-0000-4000-8000-000000000004/payments`, {
    method: "POST",
    headers: { cookie: "zenix_session=test-session", "content-type": "application/json", origin: "http://localhost:5173", "x-zenix-client": "web" },
    body: JSON.stringify({ amount: 10_000, paymentMethod: "cash" }),
  });

  assert.equal(response.status, 200);
  assert.equal(insertedStoreId, assignedStoreId);
});
