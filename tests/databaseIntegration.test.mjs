import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import pg from "pg";

import { assertSafeTestDatabaseUrl } from "../scripts/assertTestDatabase.js";
import { runMigrations, checkMigrationStatus } from "../src/db/migrationRunner.js";
import { runTransaction } from "../src/db/tx.js";
import { verifyDatabaseSchema } from "../src/db/verifySchema.js";
import { loadMigrationCatalog } from "../src/db/migrationCatalog.js";
import { executeMigration } from "../src/db/migrationExecution.js";

const { Pool } = pg;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

test("test database safety gate rejects production-looking targets", () => {
  assert.throws(() => assertSafeTestDatabaseUrl("postgresql://user:secret@ep-live-pooler.neon.tech/app_test"), /Neon/i);
  assert.throws(() => assertSafeTestDatabaseUrl("postgresql://user:secret@db.example.com/app_test"), /loopback/i);
  assert.throws(() => assertSafeTestDatabaseUrl("postgresql://user:secret@localhost:5432/zenix", { nodeEnv: "test" }), /test marker/i);
  assert.throws(() => assertSafeTestDatabaseUrl("postgresql://user:secret@localhost:5432/zenix_test", { nodeEnv: "production" }), /NODE_ENV=production/i);
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://fake:fake@localhost/zenix_test?host=ep-example-pooler.us-east-2.aws.neon.tech", { nodeEnv: "test" }),
    /connection target override/i,
  );
});

test("test database safety gate accepts an explicit loopback test database", () => {
  const parsed = assertSafeTestDatabaseUrl("postgresql://postgres:secret@127.0.0.1:5432/zenix_phase1_test", { nodeEnv: "test" });
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/zenix_phase1_test");
});

const integrationUrl = process.env.TEST_DATABASE_URL;
const integration = integrationUrl ? test : test.skip;
const testPool = (max) => new Pool({
  connectionString: integrationUrl,
  max,
  connectionTimeoutMillis: 5_000,
  options: "-c lock_timeout=5s -c statement_timeout=30s",
});

integration("migrations apply to an empty database and rerun idempotently", async () => {
  assertSafeTestDatabaseUrl(integrationUrl, { nodeEnv: process.env.NODE_ENV || "test" });
  const pool = testPool(4);
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const first = await runMigrations({ pool, directory: migrationsDirectory, logger: { log() {} } });
    const second = await runMigrations({ pool, directory: migrationsDirectory, logger: { log() {} } });
    assert.equal(first.applied.length, first.total);
    assert.equal(second.applied.length, 0);
    assert.deepEqual(await checkMigrationStatus({ db: pool, directory: migrationsDirectory }), {
      tableMissing: false,
      missing: [],
      drifted: [],
      unverified: [],
      unknown: [],
    });
    await verifyDatabaseSchema(pool);
    const guarded = await fs.readFile(path.join(migrationsDirectory, "022_mvp18_guarded_constraints.sql"), "utf8");
    await pool.query(guarded);
    await pool.query(guarded);
    const validation = await fs.readFile(path.join(migrationsDirectory, "023_validate_extra_store_constraints.sql"), "utf8");
    await pool.query(validation);
    await pool.query(validation);
    const constraint = await pool.query("SELECT convalidated FROM pg_constraint WHERE conrelid='extra_store_entitlements'::regclass AND conname='extra_store_entitlements_payment_tenant_fk'");
    assert.equal(constraint.rowCount, 1);
    assert.equal(constraint.rows[0].convalidated, true);
  } finally {
    await pool.end();
  }
});

integration("concurrent runner migrations serialize on the advisory lock and converge", async () => {
  assertSafeTestDatabaseUrl(integrationUrl, { nodeEnv: process.env.NODE_ENV || "test" });
  const pool = testPool(4);
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const [first, second] = await Promise.all([
      runMigrations({ pool, directory: migrationsDirectory, logger: { log() {} }, lockTimeoutMs: 15_000 }),
      runMigrations({ pool, directory: migrationsDirectory, logger: { log() {} }, lockTimeoutMs: 15_000 }),
    ]);
    assert.equal(first.applied.length + second.applied.length, first.total);
    assert.ok(first.applied.length === 0 || second.applied.length === 0);
    assert.deepEqual(await checkMigrationStatus({ db: pool, directory: migrationsDirectory }), {
      tableMissing: false, missing: [], drifted: [], unverified: [], unknown: [],
    });
    await verifyDatabaseSchema(pool);
  } finally {
    await pool.end();
  }
});

integration("migration validation commits ADD FK locks before its populated scan and permits concurrent writes", async () => {
  assertSafeTestDatabaseUrl(integrationUrl, { nodeEnv: process.env.NODE_ENV || "test" });
  const db = testPool(3);
  const schema = `mvp18_validation_${process.pid}_${Date.now()}`;
  let validator, writer, created = false;
  try {
    validator = await db.connect();
    writer = await db.connect();
    await validator.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await validator.query(`SET search_path TO ${schema}`);
    await writer.query(`SET search_path TO ${schema}`);
    await writer.query("SET lock_timeout='250ms'");
    await validator.query(`CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text);
      CREATE TABLE billing_payments(organization_id uuid NOT NULL,id uuid PRIMARY KEY,UNIQUE(organization_id,id));
      CREATE TABLE extra_store_entitlements(organization_id uuid NOT NULL,payment_id uuid NOT NULL);
      INSERT INTO billing_payments SELECT gen_random_uuid(),gen_random_uuid() FROM generate_series(1,2000);
      INSERT INTO extra_store_entitlements SELECT organization_id,id FROM billing_payments;`);
    const catalog = await loadMigrationCatalog(migrationsDirectory);
    const addition = catalog.find(({name}) => name === "022_mvp18_guarded_constraints.sql");
    const validation = catalog.find(({name}) => name === "023_validate_extra_store_constraints.sql");
    await executeMigration(validator, addition);
    const before = await validator.query("SELECT convalidated FROM pg_constraint WHERE conrelid='extra_store_entitlements'::regclass AND conname='extra_store_entitlements_payment_tenant_fk'");
    assert.equal(before.rows[0].convalidated, false, "022 must leave validation for its own transaction");
    assert.ok(validation, "validation migration must follow the committed addition");
    let observed = false;
    await executeMigration({query: async (sql, params) => {
      const result = await validator.query(sql, params);
      if (/VALIDATE\s+CONSTRAINT/i.test(String(sql))) {
        observed = true;
        // The real validation transaction is still open, before its COMMIT.
        const locks = await validator.query(`SELECT mode FROM pg_locks
          WHERE pid=pg_backend_pid() AND granted AND relation IN
            ('extra_store_entitlements'::regclass,'billing_payments'::regclass)`);
        assert.ok(locks.rows.some(row => row.mode === "ShareUpdateExclusiveLock"));
        assert.ok(!locks.rows.some(row => ["ShareRowExclusiveLock","AccessExclusiveLock"].includes(row.mode)),
          "validation must not retain the stronger locks from ADD FOREIGN KEY");
        const write = await writer.query(`INSERT INTO extra_store_entitlements
          SELECT organization_id,id FROM billing_payments LIMIT 1 RETURNING payment_id`);
        assert.equal(write.rowCount, 1, "a concurrent write must succeed while validation locks remain held");
      }
      return result;
    }}, validation);
    assert.equal(observed, true);
    const after = await validator.query("SELECT convalidated FROM pg_constraint WHERE conrelid='extra_store_entitlements'::regclass AND conname='extra_store_entitlements_payment_tenant_fk'");
    assert.equal(after.rows[0].convalidated, true);
  } finally {
    if (validator) {
      await validator.query("ROLLBACK").catch(() => {});
      await validator.query("RESET search_path").catch(() => {});
    }
    if (writer) await writer.query("RESET search_path").catch(() => {});
    validator?.release();
    writer?.release();
    try {
      if (created) await db.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await db.end();
    }
  }
});

integration("transactions roll back and tenant constraints reject cross-organization writes", async () => {
  assertSafeTestDatabaseUrl(integrationUrl, { nodeEnv: process.env.NODE_ENV || "test" });
  const pool = testPool(2);
  try {
    const rolledBackName = "rollback-proof-organization";
    await assert.rejects(runTransaction(pool, async (client) => {
      await client.query("INSERT INTO organizations(name) VALUES($1)", [rolledBackName]);
      throw new Error("force rollback");
    }), /force rollback/);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM organizations WHERE name=$1", [rolledBackName])).rows[0].count, 0);

    const organizationA = (await pool.query("INSERT INTO organizations(name) VALUES('Tenant A') RETURNING id")).rows[0].id;
    const organizationB = (await pool.query("INSERT INTO organizations(name) VALUES('Tenant B') RETURNING id")).rows[0].id;
    const storeA = (await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'A store') RETURNING id", [organizationA])).rows[0].id;
    await assert.rejects(
      pool.query(`INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role)
        VALUES($1,$2,'Cross tenant','cross-tenant-user','hash','CASHIER')`, [organizationB, storeA]),
      (error) => error?.constraint === "users_store_tenant_fk",
    );
    const paymentA = (await pool.query(`INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,status)
      VALUES($1,'tenant-entitlement-payment','EXTRA','MONTHLY',120000,'APPROVED') RETURNING id`, [organizationA])).rows[0].id;
    await assert.rejects(
      pool.query(`INSERT INTO extra_store_entitlements(organization_id,payment_id,quantity,duration,starts_on,expires_on)
        VALUES($1,$2,1,'MONTHLY',CURRENT_DATE,CURRENT_DATE + 30)`, [organizationB, paymentA]),
      (error) => error?.constraint === "extra_store_entitlements_payment_tenant_fk",
    );
  } finally {
    await pool.end();
  }
});

integration("account-wide failed login throttling is atomic with real PostgreSQL advisory locks", async () => {
  assertSafeTestDatabaseUrl(integrationUrl, { nodeEnv: process.env.NODE_ENV || "test" });
  const { recordLoginDecision } = await import("../src/services/loginThrottle.js");
  const db = testPool(8);
  const usernameNorm = `phase3_lock_test_${process.pid}_${Date.now()}`;
  try {
    const decisions = await Promise.allSettled(Array.from({ length: 40 }, (_, i) =>
      recordLoginDecision(db, { usernameNorm, ipAddress: `198.51.100.${i}`, success: false })));
    assert.equal(decisions.filter(row => row.status === "fulfilled").length, 30);
    assert.equal(decisions.filter(row => row.status === "rejected" && row.reason?.code === "LOGIN_RATE_LIMITED").length, 10);
    const { rows } = await db.query("SELECT count(*)::int AS failures FROM auth_login_attempts WHERE username_norm=$1 AND success=false", [usernameNorm]);
    assert.equal(rows[0].failures, 30);
  } finally {
    await db.query("DELETE FROM auth_login_attempts WHERE username_norm=$1", [usernameNorm]);
    await db.end();
  }
});

// These tests run against disposable PostgreSQL in CI, never a live Neon database.
// They deliberately exercise row-lock behaviour in the real engine; they are not
// substitutes for authenticated HTTP/browser end-to-end sale/refund tests.
integration('concurrent sale cannot accept a shift closed by another transaction',async()=>{
  assertSafeTestDatabaseUrl(integrationUrl,{nodeEnv:process.env.NODE_ENV||'test'});
  const db=testPool(3);
  let closing, selling;
  let closingTx=false, sellingTx=false;
  try{
    closing=await db.connect();
    selling=await db.connect();
    const org=(await db.query("INSERT INTO organizations(name) VALUES('Shift lock rehearsal') RETURNING id")).rows[0].id;
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Shift test') RETURNING id",[org])).rows[0].id;
    const cashier=(await db.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Cashier',$3,'test-hash','CASHIER') RETURNING id",[org,store,`phase4_shift_${Date.now()}`])).rows[0].id;
    const shift=(await db.query('INSERT INTO shifts(organization_id,store_id,cashier_id,register_key) VALUES($1,$2,$3,$4) RETURNING id',[org,store,cashier,`store:${store}`])).rows[0].id;

    await closing.query('BEGIN');closingTx=true;
    const locked=(await closing.query("SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open' FOR UPDATE",[shift,org,store])).rows[0];
    assert.ok(locked,'shift must be open before closing');
    await closing.query("UPDATE shifts SET status='closed',closed_at=now() WHERE id=$1",[shift]);

    await selling.query('BEGIN');sellingTx=true;
    await selling.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(selling.query("SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open' FOR UPDATE",[shift,org,store]),err=>err?.code==='55P03');
    await selling.query('ROLLBACK');sellingTx=false;
    await closing.query('COMMIT');closingTx=false;
    const after=await selling.query("SELECT id FROM shifts WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND status='open' FOR UPDATE",[shift,org,store]);
    assert.equal(after.rowCount,0,'a later sale must not see a closed shift');
  }finally{
    if(sellingTx)await selling.query('ROLLBACK').catch(()=>{});
    if(closingTx)await closing.query('ROLLBACK').catch(()=>{});
    selling?.release();closing?.release();await db.end();
  }
});

integration('two concurrent stock consumers cannot both read the original inventory quantity',async()=>{
  assertSafeTestDatabaseUrl(integrationUrl,{nodeEnv:process.env.NODE_ENV||'test'});
  const db=testPool(3);
  let first,second;
  let firstTx=false,secondTx=false;
  try{
    first=await db.connect();second=await db.connect();
    const org=(await db.query("INSERT INTO organizations(name) VALUES('Inventory lock rehearsal') RETURNING id")).rows[0].id;
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Inventory test') RETURNING id",[org])).rows[0].id;
    const product=(await db.query("INSERT INTO products(organization_id,name) VALUES($1,'Concurrent item') RETURNING id",[org])).rows[0].id;
    await db.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,5)',[org,store,product]);
    const lock='SELECT quantity FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 FOR UPDATE';
    const args=[org,store,product];
    await first.query('BEGIN');firstTx=true;
    const original=await first.query(lock,args);
    assert.equal(Number(original.rows[0].quantity),5);
    await second.query('BEGIN');secondTx=true;
    await second.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(second.query(lock,args),err=>err?.code==='55P03');
    await second.query('ROLLBACK');secondTx=false;
    await first.query('UPDATE inventory_balances SET quantity=$4,version=version+1 WHERE organization_id=$1 AND store_id=$2 AND product_id=$3',[...args,1]);
    await first.query('COMMIT');firstTx=false;
    const after=await second.query(lock,args);
    assert.equal(Number(after.rows[0].quantity),1);
    assert.ok(Number(after.rows[0].quantity)<4,'the second 4-unit purchase must be rejected');
  }finally{
    if(secondTx)await second.query('ROLLBACK').catch(()=>{});
    if(firstTx)await first.query('ROLLBACK').catch(()=>{});
    second?.release();first?.release();await db.end();
  }
});

integration('concurrent customer debt payment and refund decisions serialize on the customer row',async()=>{
  assertSafeTestDatabaseUrl(integrationUrl,{nodeEnv:process.env.NODE_ENV||'test'});
  const db=testPool(3);
  let refund,payment;
  let refundTx=false,paymentTx=false;
  try{
    refund=await db.connect();payment=await db.connect();
    const org=(await db.query("INSERT INTO organizations(name) VALUES('Credit lock rehearsal') RETURNING id")).rows[0].id;
    const customer=(await db.query("INSERT INTO customers(organization_id,name,credit_limit) VALUES($1,'Locked customer',1000) RETURNING id",[org])).rows[0].id;
    const lock='SELECT * FROM customers WHERE id=$1 AND organization_id=$2 FOR UPDATE';
    const args=[customer,org];
    await refund.query('BEGIN');refundTx=true;
    const original=(await refund.query(lock,args)).rows[0];
    assert.equal(Number(original.credit_limit),1000);
    await payment.query('BEGIN');paymentTx=true;
    await payment.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(payment.query(lock,args),err=>err?.code==='55P03');
    await payment.query('ROLLBACK');paymentTx=false;
    await refund.query('UPDATE customers SET credit_limit=900 WHERE id=$1 AND organization_id=$2',args);
    await refund.query('COMMIT');refundTx=false;
    const latest=(await payment.query(lock,args)).rows[0];
    assert.equal(Number(latest.credit_limit),900,'second decision must see committed customer state');
  }finally{
    if(paymentTx)await payment.query('ROLLBACK').catch(()=>{});
    if(refundTx)await refund.query('ROLLBACK').catch(()=>{});
    refund?.release();payment?.release();await db.end();
  }
});

integration('receipt reuse is serialized on locked receipt and rejected after prior submission',async()=>{
  assertSafeTestDatabaseUrl(integrationUrl,{nodeEnv:process.env.NODE_ENV||'test'});
  const {assertReceiptAvailable}=await import('../src/services/receiptReuseGuard.js');
  const db=testPool(3);
  let first,second;
  let firstTx=false,secondTx=false;
  try{
    first=await db.connect();second=await db.connect();
    const org=(await db.query("INSERT INTO organizations(name) VALUES('Receipt reuse test') RETURNING id")).rows[0].id;
    const receipt=(await db.query(`INSERT INTO billing_receipts(organization_id,file_name,mime_type,file_size,content)
      VALUES($1,'test.pdf','application/pdf',4,$2) RETURNING id`,[org,Buffer.from('test')])).rows[0].id;
    // Create identical evidence before either connection locks its parent org.
    // A third connection's FK check otherwise waits on our own FOR UPDATE lock.
    const duplicate=(await db.query(`INSERT INTO billing_receipts(organization_id,file_name,mime_type,file_size,content)
      VALUES($1,'copy.pdf','application/pdf',4,$2) RETURNING id`,[org,Buffer.from('test')])).rows[0].id;
    await first.query('BEGIN');firstTx=true;
    await first.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
    await first.query('SELECT id FROM billing_receipts WHERE id=$1 AND organization_id=$2 FOR UPDATE',[receipt,org]);
    await assertReceiptAvailable(first,{organizationId:org,receiptId:receipt});
    await second.query('BEGIN');secondTx=true;
    await second.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(second.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]),err=>err?.code==='55P03');
    await second.query('ROLLBACK');secondTx=false;
    await first.query(`INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,receipt_id)
      VALUES($1,$2,'LICENSE','MONTHLY',10000,$3)`,[org,`receipt-first-${Date.now()}`,receipt]);
    await first.query('COMMIT');firstTx=false;
    await second.query('BEGIN');secondTx=true;
    await second.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
    await second.query('SELECT id FROM billing_receipts WHERE id=$1 AND organization_id=$2 FOR UPDATE',[receipt,org]);
    await assert.rejects(assertReceiptAvailable(second,{organizationId:org,receiptId:receipt}),err=>err?.code==='BILLING_RECEIPT_ALREADY_USED');
    // Re-uploading identical bank evidence gets a new receipt ID, but must
    // never result in another approved/reviewed payment for the same tenant.
    await second.query('SELECT id FROM billing_receipts WHERE id=$1 AND organization_id=$2 FOR UPDATE',[duplicate,org]);
    await assert.rejects(assertReceiptAvailable(second,{organizationId:org,receiptId:duplicate}),
      err=>err?.code==='BILLING_RECEIPT_ALREADY_USED');

  }finally{
    if(secondTx)await second.query('ROLLBACK').catch(()=>{});
    if(firstTx)await first.query('ROLLBACK').catch(()=>{});
    first?.release();second?.release();await db.end();
  }
});
