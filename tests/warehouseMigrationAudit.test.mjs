import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeTestDatabaseUrl } from '../scripts/assertTestDatabase.js';
import { loadMigrationCatalog } from '../src/db/migrationCatalog.js';
import { executeMigration } from '../src/db/migrationExecution.js';
import { verifyDatabaseSchema } from '../src/db/verifySchema.js';
import { auditWarehouseMigration } from '../scripts/warehouseAudit.mjs';

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
const businessTables = ['organizations', 'stores', 'products', 'inventory_balances', 'inventory_batches', 'sales', 'sale_items'];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(run) {
  const url = assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, { nodeEnv: process.env.NODE_ENV || 'test' });
  const name = `warehouse_audit_test_${randomBytes(12).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  let pool, created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    const isolated = new URL(url); isolated.pathname = `/${name}`;
    assertSafeTestDatabaseUrl(isolated.toString(), { nodeEnv: 'test' });
    pool = new pg.Pool({ connectionString: isolated.toString(), max: 6, options: '-c statement_timeout=20s', connectionTimeoutMillis: 5000 });
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, name);
    const catalog = await loadMigrationCatalog(directory);
    const migration = catalog.find(m => m.prefix === '031');
    assert.ok(migration);
    await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text)');
    const setup = await pool.connect();
    try { for (const m of catalog.filter(m => m.prefix < '031')) await executeMigration(setup, m); }
    finally { setup.release(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 30);
    const org = (await pool.query("INSERT INTO organizations(name) VALUES('Warehouse audit') RETURNING id")).rows[0].id;
    const store = (await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Audit branch') RETURNING id", [org])).rows[0].id;
    const products = [];
    for (const [i, quantity] of [10, -3, 0, 0.125].entries()) {
      const id = (await pool.query("INSERT INTO products(organization_id,name) VALUES($1,$2) RETURNING id", [org, `Audit product ${i}`])).rows[0].id;
      products.push(id);
      await pool.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost) VALUES($1,$2,$3,$4,12.34)', [org, store, id, quantity]);
    }
    const sale = (await pool.query("INSERT INTO sales(organization_id,store_id,sale_number,total) VALUES($1,$2,'audit-sale',25) RETURNING id", [org, store])).rows[0].id;
    await pool.query("INSERT INTO sale_items(sale_id,product_id,product_name,quantity,unit_price,line_total) VALUES($1,$2,'Audit product 0',1,25,25)", [sale, products[0]]);
    await pool.query("INSERT INTO inventory_batches(organization_id,store_id,product_id,batch_no,received_quantity,remaining_quantity,expiry_date) VALUES($1,$2,$3,'audit-batch',10,10,'2027-01-01')", [org, store, products[0]]);
    const snapshot = async () => {
      const result = {};
      for (const table of [...businessTables, 'schema_migrations']) result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return result;
    };
    const auditor=await pool.connect();
    try{assert.equal((await auditWarehouseMigration(auditor,{phase:'before'})).ok,true);}finally{auditor.release();}
    await run({ pool, migration, org, store, products, snapshot });
  } finally {
    if (pool) await pool.end();
    if (created) {
      assert.match(name, /^warehouse_audit_test_[a-f0-9]{24}$/);
      assert.notEqual(decodeURIComponent(url.pathname.slice(1)), name);
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
      await admin.query(`DROP DATABASE "${name}"`);
    }
    await admin.end();
  }
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await fn(client); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const violation = fn => assert.rejects(fn, error => error.code === '23514');
async function commitViolation(pool, sql, values) {
  let statementCompleted=false;
  await violation(()=>transaction(pool,async c=>{await c.query(sql,values);statementCompleted=true;}));
  assert.equal(statementCompleted,true,'invariant rejection must occur at COMMIT');
}
async function partition(pool) {
  assert.deepEqual((await pool.query(`SELECT b.organization_id,b.store_id,b.product_id,b.quantity::text,
    COALESCE(sum(w.quantity),0)::numeric(18,3)::text AS partition FROM inventory_balances b
    LEFT JOIN warehouse_balances w USING(organization_id,store_id,product_id)
    GROUP BY b.organization_id,b.store_id,b.product_id,b.quantity HAVING b.quantity<>COALESCE(sum(w.quantity),0)`)).rows, []);
}
async function waitBlocked(pool, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [pid])).rowCount) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail(`writer ${pid} did not wait on migration lock`);
}

integration('031 fails safely under a busy writer and rolls back every artifact on injected failure', { timeout: 120000 }, async () => fixture(async ({pool,migration,snapshot,products}) => {
  const before = await snapshot();
  const schemaSnapshot=async()=>({
    columns:(await pool.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2")).rows,
    constraints:(await pool.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2")).rows,
    functions:(await pool.query("SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1,2")).rows,
    triggers:(await pool.query("SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2")).rows,
  });
  const schemaBefore=await schemaSnapshot();
  const writer = await pool.connect(), migrator = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('UPDATE inventory_balances SET quantity=quantity WHERE product_id=$1', [products[0]]);
    await assert.rejects(() => executeMigration(migrator,migration), e => e.code === '55P03');
    await writer.query('ROLLBACK');
    assert.deepEqual(await snapshot(),before);
    const proxy = { query: (sql, values) => {
      if (sql.startsWith('INSERT INTO schema_migrations')) throw new Error('injected post-DDL failure');
      return migrator.query(sql,values);
    }};
    await assert.rejects(() => executeMigration(proxy,migration), /injected post-DDL failure/);
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual(await schemaSnapshot(),schemaBefore);
    assert.equal((await pool.query("SELECT to_regclass('warehouses') AS w,to_regclass('warehouse_balances') AS b")).rows[0].w,null);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='inventory_batches' AND column_name='manufactured_date'")).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('sync_warehouse_balance','create_branch_default_warehouse')")).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='inventory_batch_date_order' OR conname LIKE '%quantity_finite%'")).rows[0].n,0);
  } finally { await writer.query('ROLLBACK'); writer.release(); migrator.release(); }
}));

integration('031 serializes live writes across backfill and preserves existing business rows', { timeout: 120000 }, async () => fixture(async ({pool,migration,org,store,products,snapshot}) => {
  const receiptProduct=(await pool.query("INSERT INTO products(organization_id,name) VALUES($1,'Concurrent receipt') RETURNING id",[org])).rows[0].id;
  const before = await snapshot();
  const migrator = await pool.connect(), writers = await Promise.all([pool.connect(),pool.connect(),pool.connect()]);
  const ready = deferred(), resume = deferred(); let pending;
  try {
    pending = executeMigration({query: async (sql,values) => {
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        for(const table of businessTables) {
          let rows=(await migrator.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
          if(table==='inventory_batches')rows=rows.map(r=>{const {manufactured_date,...row}=r.row;return {row};});
          assert.deepEqual(rows,before[table],`${table} must remain unchanged by backfill`);
        }
        ready.resolve(); await resume.promise;
      }
      return migrator.query(sql,values);
    }},migration);
    await Promise.race([ready.promise,pending.then(() => assert.fail('migration did not pause'))]);
    const pids = await Promise.all(writers.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    const jobs = [writers[0].query('UPDATE inventory_balances SET quantity=quantity-1 WHERE product_id=$1',[products[0]]),
      writers[1].query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,2)',[org,store,receiptProduct]),
      writers[2].query("INSERT INTO stores(organization_id,name) VALUES($1,'Concurrent branch') RETURNING id",[org])];
    try { await Promise.all(pids.map(pid => waitBlocked(pool,pid))); }
    finally { resume.resolve(); }
    await pending; await Promise.all(jobs);
    await partition(pool);
    const after = await snapshot();
    for (const table of ['organizations','products','sales','sale_items']) assert.deepEqual(after[table],before[table]);
    assert.deepEqual(after.schema_migrations.filter(r => r.row.name!==migration.name),before.schema_migrations);
    assert.deepEqual(after.inventory_batches.map(r => {const {manufactured_date,...row}=r.row;return {row};}),before.inventory_batches);
    for(const product of products.slice(1)) assert.deepEqual(after.inventory_balances.find(r=>r.row.product_id===product),before.inventory_balances.find(r=>r.row.product_id===product));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stores s LEFT JOIN warehouses w ON w.store_id=s.id AND w.is_default AND w.active WHERE w.id IS NULL')).rows[0].n,0);
  } finally { resume.resolve(); if(pending)await pending.catch(()=>{}); writers.forEach(c=>c.release());migrator.release(); }
}));

integration('031 enforces warehouse partition, immutable balance scope, finite quantity and batch dates', {timeout:120000}, async()=>fixture(async({pool,migration,org,store,products})=>{
  const client=await pool.connect(); try{await executeMigration(client,migration);}finally{client.release();}
  await verifyDatabaseSchema(pool);
  const auditor=await pool.connect();try{assert.equal((await auditWarehouseMigration(auditor,{phase:'after'})).ok,true);}finally{auditor.release();}
  await partition(pool);
  const main=(await pool.query('SELECT id FROM warehouses WHERE store_id=$1 AND is_default',[store])).rows[0].id;
  const named=(await pool.query("INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,'Named warehouse') RETURNING id",[org,store])).rows[0].id;
  await pool.query('UPDATE inventory_balances SET quantity=quantity+5 WHERE product_id=$1',[products[0]]);
  await transaction(pool,async c=>{await c.query("SELECT set_config('zenix.inventory_warehouse',$1,true)",[named]);await c.query('UPDATE inventory_balances SET quantity=quantity+3 WHERE product_id=$1',[products[0]]);await c.query('UPDATE inventory_balances SET quantity=quantity-1 WHERE product_id=$1',[products[0]]);});
  assert.equal((await pool.query('SELECT quantity FROM warehouse_balances WHERE warehouse_id=$1 AND product_id=$2',[named,products[0]])).rows[0].quantity,'2.000');
  await pool.query('UPDATE inventory_balances SET quantity=quantity-16 WHERE product_id=$1',[products[0]]);
  await partition(pool);
  await pool.query('DELETE FROM inventory_balances WHERE product_id=$1',[products[3]]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM warehouse_balances WHERE product_id=$1',[products[3]])).rows[0].n,0);
  const before=(await pool.query('SELECT * FROM inventory_balances ORDER BY product_id')).rows;
  const otherStore=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Other branch') RETURNING id",[org])).rows[0].id;
  const otherOrg=(await pool.query("INSERT INTO organizations(name) VALUES('Other org') RETURNING id")).rows[0].id;
  for(const [column,value] of [['store_id',otherStore],['product_id',products[3]],['organization_id',otherOrg]]) await violation(()=>pool.query(`UPDATE inventory_balances SET ${column}=$1 WHERE product_id=$2`,[value,products[0]]));
  await violation(()=>pool.query('UPDATE inventory_balances SET product_id=$1,quantity=quantity+1 WHERE product_id=$2',[products[3],products[0]]));
  assert.deepEqual((await pool.query('SELECT * FROM inventory_balances ORDER BY product_id')).rows,before);
  await commitViolation(pool,'UPDATE warehouse_balances SET quantity=quantity+1 WHERE warehouse_id=$1 AND product_id=$2',[main,products[0]]);
  await transaction(pool,async c=>{await c.query('UPDATE warehouse_balances SET quantity=quantity-1 WHERE warehouse_id=$1 AND product_id=$2',[main,products[0]]);await c.query('UPDATE warehouse_balances SET quantity=quantity+1 WHERE warehouse_id=$1 AND product_id=$2',[named,products[0]]);});
  await violation(()=>transaction(pool,c=>c.query('INSERT INTO warehouse_balances(organization_id,store_id,warehouse_id,product_id,quantity) VALUES($1,$2,$3,$4,0)',[org,store,main,products[3]])));
  for(const sql of ['DELETE FROM warehouses WHERE id=$1','UPDATE warehouses SET is_default=false WHERE id=$1']) await commitViolation(pool,sql,[main]);
  await violation(()=>transaction(pool,c=>c.query('UPDATE warehouses SET active=false WHERE id=$1',[main])));
  for(const table of ['inventory_balances','warehouse_balances','warehouses']) await violation(()=>transaction(pool,c=>c.query(`TRUNCATE ${table} CASCADE`)));
  const initial=(await pool.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[products[0]])).rows[0].quantity;
  await Promise.all([transaction(pool,c=>c.query('UPDATE inventory_balances SET quantity=quantity-0.125 WHERE product_id=$1',[products[0]])),transaction(pool,c=>c.query('UPDATE inventory_balances SET quantity=quantity-0.125 WHERE product_id=$1',[products[0]]))]);
  assert.equal(Number((await pool.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[products[0]])).rows[0].quantity),Number(initial)-0.25);
  await partition(pool);
  await violation(()=>pool.query("UPDATE inventory_balances SET quantity='NaN' WHERE product_id=$1",[products[0]]));
  await violation(()=>pool.query("UPDATE warehouse_balances SET quantity='NaN' WHERE product_id=$1",[products[0]]));
  await violation(()=>pool.query("UPDATE inventory_batches SET manufactured_date='2027-02-01' WHERE product_id=$1",[products[0]]));
  await pool.query("UPDATE inventory_batches SET manufactured_date='2026-12-01' WHERE product_id=$1",[products[0]]);
  await pool.query('DELETE FROM stores WHERE id=$1',[otherStore]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM warehouses WHERE store_id=$1',[otherStore])).rows[0].n,0);
  await pool.query("UPDATE warehouses SET name='Renamed main' WHERE id=$1",[main]);
  await pool.query("INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,'Asosiy ombor')",[org,store]);
  await pool.query('UPDATE inventory_balances SET quantity=quantity+0.001 WHERE product_id=$1',[products[0]]);
  await partition(pool);
  const boundary=(await pool.query("INSERT INTO products(organization_id,name) VALUES($1,'Numeric boundary') RETURNING id",[org])).rows[0].id;
  await pool.query("INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,-900000000000000)",[org,store,boundary]);
  for(const quantity of ['900000000000000','-900000000000000']){
    await pool.query('UPDATE inventory_balances SET quantity=$1 WHERE product_id=$2',[quantity,boundary]);
    assert.equal((await pool.query('SELECT quantity FROM warehouse_balances WHERE warehouse_id=$1 AND product_id=$2',[main,boundary])).rows[0].quantity,`${quantity}.000`);
    await partition(pool);
  }
  const stock=await pool.connect(),deleting=await pool.connect();
  try{
    await stock.query('BEGIN');await deleting.query('BEGIN');
    await stock.query('UPDATE inventory_balances SET quantity=quantity+1 WHERE product_id=$1',[products[0]]);
    const pid=(await deleting.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const deletion=deleting.query('DELETE FROM warehouses WHERE id=$1',[main]);
    await waitBlocked(pool,pid);
    await stock.query('COMMIT');
    await deletion;
    await violation(()=>deleting.query('COMMIT'));
    await partition(pool);
    assert.equal((await pool.query('SELECT active,is_default FROM warehouses WHERE id=$1',[main])).rows[0].is_default,true);
  }finally{await stock.query('ROLLBACK');await deleting.query('ROLLBACK');stock.release();deleting.release();}
}));
