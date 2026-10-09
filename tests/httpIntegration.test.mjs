import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertSafeTestDatabaseUrl } from '../scripts/assertTestDatabase.js';

// Run only after the disposable PostgreSQL test database has been migrated.
// Never connect this test to a live Neon endpoint or an ambiguous DB name.
const testUrl = process.env.TEST_DATABASE_URL;
const integration = testUrl ? test : test.skip;

integration('authenticated tenant HTTP smoke: login, product isolation, permissions and license expiry', {timeout:60000}, async () => {
  const parsed = assertSafeTestDatabaseUrl(testUrl, { nodeEnv: process.env.NODE_ENV || 'test' });
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DATABASE_URL, testUrl, 'app and test pool must point at the exact same disposable test database');
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname));

  const [{ default: pg }, { default: bcrypt }, { app }, { pool: appPool }] = await Promise.all([
    import('pg'), import('bcryptjs'), import('../src/app.js'), import('../src/db/pool.js'),
  ]);
  const db = new pg.Pool({ connectionString: testUrl, max: 3, connectionTimeoutMillis:5000, options:'-c lock_timeout=5s -c statement_timeout=30s' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin: 'http://localhost:5173', 'x-zenix-client': 'web', 'content-type': 'application/json' };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const password = `HttpTest!${suffix}`;
  const passwordHash = await bcrypt.hash(password, 4);
  const accounts = [];
  async function request(path, { cookie, method = 'GET', body, omitClientMarker = false } = {}) {
    const requestHeaders = { ...headers };
    if (cookie) requestHeaders.cookie = cookie;
    if (omitClientMarker) delete requestHeaders['x-zenix-client'];
    const response = await fetch(`${base}${path}`, {
      method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    return { status: response.status, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    for (const side of ['a', 'b']) {
      const org = (await db.query(`INSERT INTO organizations(name,license_status,expiry_date)
        VALUES($1,'ACTIVE',CURRENT_DATE + interval '30 days') RETURNING id`, [`HTTP Smoke ${side} ${suffix}`])).rows[0];
      const store = (await db.query(`INSERT INTO stores(organization_id,name) VALUES($1,$2) RETURNING id`, [org.id, `Store ${side}`])).rows[0];
      const username = `http_smoke_${side}_${suffix}`;
      await db.query(`INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role)
        VALUES($1,$2,$3,$4,$5,'OWNER')`, [org.id, store.id, `Owner ${side}`, username, passwordHash]);
      accounts.push({ orgId: org.id, storeId: store.id, username });
    }
    for (const account of accounts) {
      const login = await request('/api/auth/login', { method: 'POST', body: { username: account.username, password } });
      assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.payload)}`);
      assert.ok(login.cookie?.startsWith('zenix_session='));
      account.cookie = login.cookie;
    }
    const [a, b] = accounts;

    // Full HTTP path: only true images/PDFs can be saved. MIME alone is not
    // sufficient, even if sent by an authenticated shop owner.
    const wrongContent=await fetch(`${base}/api/files`,{
      method:'POST',headers:{origin:'http://localhost:5173','x-zenix-client':'web',
        cookie:a.cookie,'content-type':'image/png','x-file-name':'fake.png'},
      body:Buffer.from('<script>wrong format</script>'),
    });
    assert.equal(wrongContent.status,415,'forged PNG must be rejected before storage');
    assert.equal((await wrongContent.json()).error.code,'FILE_CONTENT_MISMATCH');
    const goodContent=await fetch(`${base}/api/files`,{
      method:'POST',headers:{origin:'http://localhost:5173','x-zenix-client':'web',
        cookie:a.cookie,'content-type':'image/png','x-file-name':'proof.png'},
      body:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(12)]),
    });
    assert.equal(goodContent.status,201,'valid PNG remains supported');
    const assetId=(await goodContent.json()).data?.file?.id;
    assert.ok(assetId);
    const foreignAsset=await request(`/api/files/${assetId}`,{cookie:b.cookie});
    assert.equal(foreignAsset.status,404,'other tenant cannot download the uploaded asset');

    const created = await request('/api/products', {
      cookie: a.cookie, method: 'POST', body: { name: `Isolated product ${suffix}`, sellPrice: 8500, costPrice: 5000 },
    });
    assert.equal(created.status, 201, `create failed: ${JSON.stringify(created.payload)}`);
    const productId = created.payload?.data?.product?.id;
    assert.ok(productId);

    const own = await request('/api/products', { cookie: a.cookie });
    const others = await request('/api/products', { cookie: b.cookie });
    assert.equal(own.status, 200);
    assert.equal(others.status, 200);
    assert.ok(own.payload.data.products.some(p => p.id === productId));
    assert.ok(!others.payload.data.products.some(p => p.id === productId), 'tenant B must not see tenant A products');
    const crossTenantEdit = await request(`/api/products/${productId}`, {
      cookie: b.cookie, method: 'PATCH', body: { name: 'Tampered cross tenant' },
    });
    assert.equal(crossTenantEdit.status, 404, 'tenant B must not edit tenant A products');
    // Exercise actual API transactions rather than only SELECT FOR UPDATE in a mock.
    const receiptStock = await request('/api/inventory/adjust', {
      cookie: a.cookie, method: 'POST',
      body: { storeId: a.storeId, productId, delta: 3, reason: 'HTTP smoke initial count' },
    });
    assert.equal(receiptStock.status, 200, `stock adjustment failed: ${JSON.stringify(receiptStock.payload)}`);
    const movement=(await db.query("SELECT reference_id FROM stock_movements WHERE id=$1 AND organization_id=$2",[receiptStock.payload.data.id,a.orgId])).rows[0];
    assert.equal(movement.reference_id,receiptStock.payload.data.id,'adjustment UUID remains the text audit reference');
    const opened = await request('/api/shifts/open', {
      cookie: a.cookie, method: 'POST', body: { storeId: a.storeId, openingCash: 0 },
    });
    assert.equal(opened.status, 201, `shift open failed: ${JSON.stringify(opened.payload)}`);
    const shiftId = opened.payload?.data?.shift?.id;
    assert.ok(shiftId);
    const saleInput = {
      storeId: a.storeId, shiftId,
      items: [{ productId, quantity: 2, unitPrice: 8500 }],
      payments: [{ method: 'cash', amount: 17000 }],
    };
    const concurrent = await Promise.all([0, 1].map(index => request('/api/sales', {
      cookie: a.cookie, method: 'POST', body: { ...saleInput, clientReference: `http-sale-${suffix}-${index}` },
    })));
    assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 409],
      `parallel sales must not oversell: ${JSON.stringify(concurrent.map(result => result.payload))}`);
    const sale = concurrent.find(result => result.status === 201).payload?.data?.sale;
    assert.ok(sale?.id);
    const stockAfterSale = await db.query('SELECT quantity FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3',
      [a.orgId, a.storeId, productId]);
    assert.equal(Number(stockAfterSale.rows[0].quantity), 1);

    const returned = await request(`/api/sales/${sale.id}/returns`, {
      cookie: a.cookie, method: 'POST',
      body: { productId, quantity: 1, reason: 'HTTP smoke test return', refundMethod: 'original', refundShiftId: shiftId },
    });
    assert.equal(returned.status, 201, `cash refund failed: ${JSON.stringify(returned.payload)}`);
    const stockAfterRefund = await db.query('SELECT quantity FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3',
      [a.orgId, a.storeId, productId]);
    assert.equal(Number(stockAfterRefund.rows[0].quantity), 2);

    const closed = await request(`/api/shifts/${shiftId}/close`, {
      cookie: a.cookie, method: 'POST', body: { actualCash: 8500 },
    });
    assert.equal(closed.status, 200, `shift close failed: ${JSON.stringify(closed.payload)}`);
    const afterClose = await request('/api/sales', {
      cookie: a.cookie, method: 'POST',
      body: { ...saleInput, clientReference: `http-after-close-${suffix}` },
    });
    assert.equal(afterClose.status, 409, 'a closed shift cannot process further sales');

    const blockedAdmin = await request('/api/platform/overview', { cookie: a.cookie });
    assert.equal(blockedAdmin.status, 403, 'ordinary tenant owner must not access platform administration');
    const missingClientMarker = await request('/api/products', {
      cookie: a.cookie, method: 'POST', body: { name: 'Forbidden post' }, omitClientMarker: true,
    });
    assert.equal(missingClientMarker.status, 403);

    await db.query("UPDATE organizations SET license_status='SUSPENDED' WHERE id=$1", [a.orgId]);
    const suspended = await request('/api/products', { cookie: a.cookie });
    assert.equal(suspended.status, 403, 'existing session cannot bypass administrator suspension');
    assert.equal(suspended.payload.error.code,'ACCOUNT_SUSPENDED');

    await db.query("UPDATE organizations SET license_status='ACTIVE',expiry_date=CURRENT_DATE - interval '1 day' WHERE id=$1", [a.orgId]);
    const expired = await request('/api/products', { cookie: a.cookie });
    assert.equal(expired.status, 402, 'expired license must block an existing session');
    const renewal = await request('/api/billing/draft', { cookie: a.cookie });
    assert.equal(renewal.status, 200, 'expired tenants must still be able to renew subscriptions');
    const unaffected = await request('/api/products', { cookie: b.cookie });
    assert.equal(unaffected.status, 200, 'other tenant must stay operational');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await appPool.end();
    await db.end();
  }
});
