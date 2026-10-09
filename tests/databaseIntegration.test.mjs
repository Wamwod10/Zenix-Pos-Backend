import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import pg from "pg";
import vm from "node:vm";
import { HttpError } from "../src/lib/http.js";

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

function registerStoreAuthorizationIntegration(){
integration('queued store authorization observes committed access changes before business mutation', {timeout:30_000}, async(t)=>{
  const {lockStoreTradingAuthorization}=await import('../src/services/storeTradingHolds.js');
  const db=testPool(3);
  try{
    const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit,timezone) VALUES('Task 5 queued authorization','ACTIVE',CURRENT_DATE+30,2,'Asia/Tashkent') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Primary')",[org]);
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Protected extra') RETURNING id",[org])).rows[0].id;
    await db.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Owner',$3,'hash','OWNER')",[org,store,`task5-${org}`]);
    for(const [change,code,now] of [
      ["license_status='SUSPENDED'",'ACCOUNT_SUSPENDED'],
      ["settings=jsonb_build_object('billingHold',true)",'BILLING_HOLD'],
      ["license_status='PAYMENT_REQUIRED'",'PAYMENT_REQUIRED'],
      ["expiry_date=CURRENT_DATE-1",'LICENSE_EXPIRED'],
      ["store_limit=1",'STORE_ENTITLEMENT_EXPIRED'],
      ["settings=jsonb_build_object('storeTradingHolds',jsonb_build_object($2::text,jsonb_build_object('reason','Explicit hold')))",'STORE_TRADING_HOLD'],
      ["timezone='Asia/Tashkent',expiry_date='2026-10-08'",'LICENSE_EXPIRED',new Date('2026-10-08T20:00:00Z')],
    ])await t.test(code,async()=>{
      await db.query("UPDATE organizations SET license_status='ACTIVE',expiry_date=CURRENT_DATE+30,store_limit=2,timezone='UTC',settings='{}'::jsonb WHERE id=$1",[org]);
      const admin=await db.connect(),writer=await db.connect();
      try{
        await admin.query('BEGIN');await writer.query('BEGIN');
        await admin.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
        const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const queued=(async()=>{
          await lockStoreTradingAuthorization(writer,{organizationId:org,storeId:store,now});
          await writer.query("INSERT INTO sale_holds(organization_id,store_id,user_id,name,cart,total) SELECT $1,$2,id,'Should never write','[]',0 FROM users WHERE organization_id=$1 LIMIT 1",[org,store]);
        })();
        const rejected=assert.rejects(queued,error=>error.code===code);
        const deadline=Date.now()+3000;
        let waiting=false;
        while(Date.now()<deadline){
          waiting=(await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[writerPid])).rows[0]?.waiting;
          if(waiting)break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.equal(waiting,true,'operation must actually queue behind the organization lock');
        await admin.query(`UPDATE organizations SET ${change} WHERE id=$1`,change.includes('$2')?[org,store]:[org]);
        await admin.query('COMMIT');
        await rejected;
        assert.equal((await writer.query('SELECT count(*)::int n FROM sale_holds WHERE organization_id=$1',[org])).rows[0].n,0);
      }finally{await admin.query('ROLLBACK');await writer.query('ROLLBACK');admin.release();writer.release();}
    });
  }finally{await db.end();}
});
}

function registerQueuedRouteIntegration(){
integration('queued sales and shift openings reject admin changes without business rows', {timeout:30_000}, async(t)=>{
  const {default:sales}=await import('../src/routes/sales.js');
  const {default:shifts}=await import('../src/routes/shifts.js');
  const {pool}=await import('../src/db/pool.js');
  const db=testPool(3),originalConnect=pool.connect;
  try{
    const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit,timezone) VALUES('Task 5 queued routes','ACTIVE',CURRENT_DATE+30,2,'Asia/Tashkent') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Primary')",[org]);
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Protected extra') RETURNING id",[org])).rows[0].id;
    const user=(await db.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Owner',$3,'hash','OWNER') RETURNING id",[org,store,`task5-route-${org}`])).rows[0].id;
    for(const [change,code] of [
      ["license_status='SUSPENDED'",'ACCOUNT_SUSPENDED'],
      ["settings=jsonb_build_object('billingHold',true)",'BILLING_HOLD'],
      ["license_status='PAYMENT_REQUIRED'",'PAYMENT_REQUIRED'],
      ["expiry_date=CURRENT_DATE-1",'LICENSE_EXPIRED'],
      ["store_limit=1",'STORE_ENTITLEMENT_EXPIRED'],
      ["settings=jsonb_build_object('storeTradingHolds',jsonb_build_object($2::text,jsonb_build_object('reason','Explicit hold')))",'STORE_TRADING_HOLD'],
    ])for(const [router,path,body] of [
      [sales,'/',{storeId:store,shiftId:user,items:[{productId:user,quantity:1,unitPrice:10}],payments:[{method:'cash',amount:10}]}],
      [shifts,'/open',{storeId:store}],
    ])await t.test(`${path} ${code}`,async()=>{
      await db.query("UPDATE organizations SET license_status='ACTIVE',expiry_date=CURRENT_DATE+30,store_limit=2,settings='{}'::jsonb WHERE id=$1",[org]);
      const admin=await db.connect(),writer=await db.connect();
      pool.connect=async()=>({query:writer.query.bind(writer),release(){}});
      try{
        await admin.query('BEGIN');await admin.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
        const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const operation=(async()=>{
          let failure;
          const handler=router.stack.find(layer=>layer.route?.path===path&&layer.route.methods.post).route.stack.at(-1).handle;
          await handler({body,user:{id:user,organizationId:org,storeId:store,appRole:'OWNER',name:'Owner'}},{status(){return this},json(){}},error=>{failure=error});
          if(failure)throw failure;
        })();
        const rejected=assert.rejects(operation,error=>error.code===code);
        const deadline=Date.now()+3000;
        let waiting=false;
        while(Date.now()<deadline){
          waiting=(await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting;
          if(waiting)break;
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.equal(waiting,true);
        await admin.query(`UPDATE organizations SET ${change} WHERE id=$1`,change.includes('$2')?[org,store]:[org]);
        await admin.query('COMMIT');await rejected;
        assert.equal((await db.query('SELECT count(*)::int n FROM sales WHERE organization_id=$1',[org])).rows[0].n,0);
        assert.equal((await db.query('SELECT count(*)::int n FROM shifts WHERE organization_id=$1',[org])).rows[0].n,0);
      }finally{await admin.query('ROLLBACK');await writer.query('ROLLBACK');admin.release();writer.release();pool.connect=originalConnect;}
    });
  }finally{pool.connect=originalConnect;await db.end();}
});
}

function registerPromoReservationIntegration(){
integration('promo reservation concurrent final slot, atomic rollback, retry, deactivation and terminal release',async(t)=>{
 const {reservePromo,consumePromoReservation,releasePromoReservation}=await import('../src/services/promoCodes.js');
 const {applyBillingReview}=await import('../src/services/billingReview.js');
 const db=testPool(4);
 try{
  const orgs=(await db.query("INSERT INTO organizations(name) VALUES('Promo A'),('Promo B') RETURNING id")).rows.map(x=>x.id);
  const users=[];
  for(const org of orgs)users.push((await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Promo owner',$2,'hash','OWNER') RETURNING id",[org,`promo-${org}`])).rows[0].id);
  const promo=(await db.query("INSERT INTO platform_promos(code,plan,discount_percent,max_uses,max_uses_per_org) VALUES($1,'MONTHLY',50,1,1) RETURNING *",[`PROMO-${Date.now()}`])).rows[0];
  const drafts=[];
  for(let i=0;i<2;i++)drafts.push((await db.query(`INSERT INTO billing_drafts(organization_id,created_by,order_id,type,plan,base_amount,total_amount,metadata)
   VALUES($1,$2,$3,'LICENSE','MONTHLY',350000,175000,$4) RETURNING *`,[orgs[i],users[i],`quote-${orgs[i]}`,{promoId:promo.id,promoCode:promo.code,promoDiscount:175000,promoDiscountPercent:50}])).rows[0]);
  const submit=(i,fail=false)=>runTransaction(db,async(client)=>{
   await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[orgs[i]]);
   const payment=(await client.query(`INSERT INTO billing_payments(organization_id,draft_id,order_id,type,plan,amount,service_period_to)
    VALUES($1,$2,$3,'LICENSE','MONTHLY',175000,CURRENT_DATE+30) RETURNING *`,[orgs[i],drafts[i].id,`payment-${orgs[i]}-${Date.now()}`])).rows[0];
   const reservation=await reservePromo(client,{paymentId:payment.id,organizationId:orgs[i]});
   if(fail)throw new Error('atomic rollback');
   return {payment,reservation,i};
  });
  await t.test('failed submit rolls back payment and reservation together',async()=>{
   await assert.rejects(submit(0,true),/atomic rollback/);
   assert.equal((await db.query('SELECT count(*)::int n FROM platform_promo_reservations WHERE promo_id=$1',[promo.id])).rows[0].n,0);
   assert.equal((await db.query('SELECT count(*)::int n FROM billing_payments WHERE organization_id=$1',[orgs[0]])).rows[0].n,0);
  });
  const results=await Promise.allSettled([submit(0),submit(1)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='PROMO_EXHAUSTED').length,1);
  const winner=results.find(x=>x.status==='fulfilled').value;
  assert.equal(winner.reservation.quote_service_period_from,null);
  assert.equal(winner.reservation.quote_service_period_to.getTime(),winner.payment.service_period_to.getTime());
  assert.equal(winner.reservation.quote_extra_store_count,0);
  await db.query('UPDATE platform_promos SET active=false WHERE id=$1',[promo.id]);
  await runTransaction(db,async(client)=>{
   const again=await reservePromo(client,{paymentId:winner.payment.id,organizationId:orgs[winner.i]});
   assert.equal(again.id,winner.reservation.id);
  });
  const originalOrganization=(await db.query('SELECT plan,license_status,expiry_date,store_limit FROM organizations WHERE id=$1',[orgs[winner.i]])).rows[0];
  for(const [field,value] of [['amount',175001],['service_period_from','2099-10-09'],['service_period_to','2099-11-09'],['extra_store_count',20]]){
   await t.test(`approval rejects changed ${field} and rolls back promo use and all entitlements`,async()=>{
    await assert.rejects(runTransaction(db,async(client)=>{
     await client.query(`UPDATE billing_payments SET ${field}=$2 WHERE id=$1`,[winner.payment.id,value]);
     await assert.rejects(applyBillingReview(client,{paymentId:winner.payment.id,decision:'APPROVED'}),error=>error.code==='PROMO_QUOTE_STALE');
     throw new Error('expected quote test rollback');
    }),/expected quote test rollback/);
    assert.equal((await db.query('SELECT status FROM billing_payments WHERE id=$1',[winner.payment.id])).rows[0].status,'REVIEW');
    assert.equal((await db.query('SELECT status FROM platform_promo_reservations WHERE payment_id=$1',[winner.payment.id])).rows[0].status,'RESERVED');
    assert.equal((await db.query('SELECT count(*)::int n FROM platform_promo_uses WHERE payment_id=$1',[winner.payment.id])).rows[0].n,0);
    assert.equal((await db.query('SELECT used_count FROM platform_promos WHERE id=$1',[promo.id])).rows[0].used_count,0);
    assert.equal((await db.query('SELECT count(*)::int n FROM extra_store_entitlements WHERE payment_id=$1',[winner.payment.id])).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1 AND action='approve'",[winner.payment.id])).rows[0].n,0);
    assert.deepEqual((await db.query('SELECT plan,license_status,expiry_date,store_limit FROM organizations WHERE id=$1',[orgs[winner.i]])).rows[0],originalOrganization);
   });
  }
  await runTransaction(db,async(client)=>{
   const result=await applyBillingReview(client,{paymentId:winner.payment.id,decision:'APPROVED'});
   assert.equal(result.outcome,'approved');
   await consumePromoReservation(client,winner.payment.id);
   await releasePromoReservation(client,winner.payment.id,'retry');
  });
  assert.equal((await db.query('SELECT status FROM platform_promo_reservations WHERE payment_id=$1',[winner.payment.id])).rows[0].status,'CONSUMED');
  assert.equal((await db.query('SELECT count(*)::int n FROM platform_promo_uses WHERE payment_id=$1',[winner.payment.id])).rows[0].n,1);
  assert.equal((await db.query('SELECT used_count FROM platform_promos WHERE id=$1',[promo.id])).rows[0].used_count,1);
  await db.query('UPDATE platform_promos SET active=true,max_uses=10 WHERE id=$1',[promo.id]);
  await assert.rejects(submit(winner.i),err=>err.code==='PROMO_ORG_LIMIT');
  const loser=1-winner.i;
  const rejected=await submit(loser);
  await runTransaction(db,client=>applyBillingReview(client,{paymentId:rejected.payment.id,decision:'REJECTED',reason:'Invalid evidence'}));
  assert.equal((await db.query('SELECT status FROM platform_promo_reservations WHERE payment_id=$1',[rejected.payment.id])).rows[0].status,'RELEASED');
  const expired=await submit(loser);
  await runTransaction(db,async(client)=>{
   await client.query("UPDATE billing_payments SET status='EXPIRED' WHERE id=$1",[expired.payment.id]);
   assert.equal((await client.query('SELECT status FROM platform_promo_reservations WHERE payment_id=$1',[expired.payment.id])).rows[0].status,'RELEASED','terminal status writes must release capacity atomically');
   await releasePromoReservation(client,expired.payment.id,'EXPIRED');
   await releasePromoReservation(client,expired.payment.id,'duplicate');
  });
  assert.deepEqual((await db.query('SELECT status,release_reason FROM platform_promo_reservations WHERE payment_id=$1',[expired.payment.id])).rows[0],{status:'RELEASED',release_reason:'EXPIRED'});
  await assert.rejects(runTransaction(db,client=>reservePromo(client,{paymentId:expired.payment.id,organizationId:orgs[winner.i]})),err=>err.code==='PAYMENT_NOT_FOUND');
  const foreignPayment=(await db.query("INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,status) VALUES($1,$2,'LICENSE','MONTHLY',350000,'APPROVED') RETURNING id",[orgs[winner.i],`foreign-${Date.now()}`])).rows[0].id;
  await assert.rejects(db.query(`INSERT INTO platform_promo_reservations(promo_id,organization_id,payment_id,plan,discount_amount,quote_amount)
   VALUES($1,$2,$3,'MONTHLY',175000,175000)`,[promo.id,orgs[loser],foreignPayment]),err=>err.constraint==='platform_promo_reservations_payment_tenant_fk');
  await t.test('registered payment submit reserves atomically and retries return the same pending payment',async()=>{
   const {default:router,calculateDraft}=await import('../src/routes/billing.js');
   const {buildBillingDraftMetadata}=await import('../src/services/billingDraftMetadata.js');
   const {pool}=await import('../src/db/pool.js');
   const connect=pool.connect;
   pool.connect=db.connect.bind(db); // Real transactions use only this bounded disposable pool.
   try{
    const org=(await db.query("INSERT INTO organizations(name) VALUES('Route promo owner') RETURNING id")).rows[0].id;
    const user=(await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Owner',$2,'hash','OWNER') RETURNING id",[org,`route-${org}`])).rows[0].id;
    const input={type:'LICENSE',intent:'ACTIVATE',plan:'MONTHLY',promoCode:promo.code,extraStoreCount:0,metadata:{}};
    const quote=await runTransaction(db,client=>calculateDraft(client,{organizationId:org},input));
    const draft=(await db.query(`INSERT INTO billing_drafts(organization_id,created_by,order_id,type,plan,current_end_date,selected_end_date,extension_days,base_amount,total_amount,metadata)
      VALUES($1,$2,$3,'LICENSE','MONTHLY',$4,$5,$6,$7,$8,$9) RETURNING id`,[org,user,`route-${org}`,quote.currentEndDate,quote.selectedEndDate,quote.extensionDays,quote.baseAmount,quote.totalAmount,buildBillingDraftMetadata(input,quote)])).rows[0].id;
    const receipt=(await db.query("INSERT INTO billing_receipts(organization_id,file_name,mime_type,file_size,content) VALUES($1,'proof.pdf','application/pdf',4,$2) RETURNING id",[org,Buffer.from('test')])).rows[0].id;
    const handler=router.stack.find(layer=>layer.route?.path==='/payments'&&layer.route.methods.post).route.stack.at(-1).handle;
    const invoke=async()=>{
      let body,failure;
      const res={status(){return this},json(value){body=value}};
      await handler({body:{draftId:draft,receiptId:receipt},user:{id:user,organizationId:org}},res,error=>{failure=error});
      if(failure)throw failure;
      return body.data.payment;
    };
    const [first,retry]=await Promise.all([invoke(),invoke()]);
    assert.equal(first.id,retry.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM platform_promo_reservations WHERE payment_id=$1',[first.id])).rows[0].n,1);
    assert.equal((await db.query('SELECT status FROM billing_drafts WHERE id=$1',[draft])).rows[0].status,'submitted');
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1 AND action='submit'",[first.id])).rows[0].n,1);
   }finally{pool.connect=connect;}
  });
  await t.test('migration backfills valid legacy pending quotes once after deactivation',async()=>{
   const history=(await db.query(`INSERT INTO billing_payments(organization_id,draft_id,order_id,type,plan,amount,service_period_to)
    VALUES($1,$2,$3,'LICENSE','MONTHLY',175000,CURRENT_DATE+30) RETURNING id`,[orgs[loser],drafts[loser].id,`legacy-${Date.now()}`])).rows[0].id;
   await db.query('UPDATE platform_promos SET active=false WHERE id=$1',[promo.id]);
   const sql=await fs.readFile(path.join(migrationsDirectory,'024_promo_reservations.sql'),'utf8');
   await db.query(sql);await db.query(sql);
   const rows=(await db.query(`SELECT status,quote_amount,quote_service_period_from,quote_service_period_to,quote_extra_store_count
     FROM platform_promo_reservations WHERE payment_id=$1`,[history])).rows;
   assert.equal(rows.length,1);
   assert.equal(rows[0].status,'RESERVED');assert.equal(rows[0].quote_amount,'175000.00');
   assert.equal(rows[0].quote_service_period_from,null);assert.equal(rows[0].quote_extra_store_count,0);
   assert.equal(rows[0].quote_service_period_to.getTime(),winner.payment.service_period_to.getTime());
   const result=await runTransaction(db,client=>applyBillingReview(client,{paymentId:history,decision:'APPROVED'}));
   assert.equal(result.outcome,'approved');
  });
 }finally{await db.end();}
});
}

function registerInventoryCountIntegration(){
integration('inventory count batch reconciliation reaches the requested total with real PostgreSQL locks',async(t)=>{
  assertSafeTestDatabaseUrl(integrationUrl,{nodeEnv:process.env.NODE_ENV||'test'});
  const source=await fs.readFile(new URL('../src/routes/inventory.js',import.meta.url),'utf8');
  const {reconcileCountBatches,applyCount}=vm.runInNewContext(`${source.slice(source.indexOf('async function lockBalance'),source.indexOf('async function allocateTransferTracking'))}
    ${source.slice(source.indexOf('async function applyCount'),source.indexOf('router.post("/counts"'))}
    ({reconcileCountBatches,applyCount})`,{HttpError});
  const db=testPool(2);
  let client,contender,transaction=false,contenderTx=false;
  try{
    client=await db.connect();contender=await db.connect();
    await client.query('BEGIN');transaction=true;
    const org=(await client.query("INSERT INTO organizations(name) VALUES('Count batch reconciliation') RETURNING id")).rows[0].id;
    const otherOrg=(await client.query("INSERT INTO organizations(name) VALUES('Other count tenant') RETURNING id")).rows[0].id;
    const store=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'Count store') RETURNING id",[org])).rows[0].id;
    const otherStore=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'Other store') RETURNING id",[org])).rows[0].id;
    const tenantStore=(await client.query("INSERT INTO stores(organization_id,name) VALUES($1,'Other tenant store') RETURNING id",[otherOrg])).rows[0].id;
    const product=async(balance)=>{
      const id=(await client.query("INSERT INTO products(organization_id,name) VALUES($1,'Counted lot product') RETURNING id",[org])).rows[0].id;
      await client.query('INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity) VALUES($1,$2,$3,$4)',[org,store,id,balance]);
      return id;
    };
    const batch=async(productId,quantity,{storeId=store,organizationId=org,expiry='2027-01-01',created='2026-01-01',id=null}={})=>(await client.query(`INSERT INTO inventory_batches
      (id,organization_id,store_id,product_id,batch_no,expiry_date,received_quantity,remaining_quantity,created_at)
      VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,'Supplier lot',$5,$6,$7,$8) RETURNING id`,[id,organizationId,storeId,productId,expiry,Math.max(1,quantity),quantity,created])).rows[0].id;
    const count=async(productId,before,after)=>applyCount(client,{orgId:org,storeId:store,changes:[{productId,before,after}],userId:null,countId:'reconciliation-test',strictSnapshot:true});
    const total=async(productId)=>Number((await client.query('SELECT COALESCE(sum(remaining_quantity),0) AS total FROM inventory_batches WHERE organization_id=$1 AND store_id=$2 AND product_id=$3',[org,store,productId])).rows[0].total);

    for(const fixture of [
      {name:'aggregate drift',before:20,after:7,lots:[3,2]},
      {name:'unchanged aggregate drift',before:5,after:5,lots:[2]},
      {name:'historical zero-positive lots',before:0,after:3,lots:[0]},
      {name:'decrease',before:5,after:2,lots:[3,2]},
      {name:'increase',before:5,after:8,lots:[3,2]},
      {name:'exact equality',before:20,after:5,lots:[3,2]},
      {name:'fractional equality',before:1,after:0.3,lots:[0.1,0.2]},
    ])await t.test(fixture.name,async()=>{
      const id=await product(fixture.before);
      for(const quantity of fixture.lots)await batch(id,quantity);
      const original=(await client.query('SELECT * FROM inventory_batches WHERE product_id=$1 ORDER BY id',[id])).rows;
      await count(id,fixture.before,fixture.after);
      assert.equal(await total(id),fixture.after);
      assert.equal(Number((await client.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[id])).rows[0].quantity),fixture.after);
      const after=(await client.query('SELECT * FROM inventory_batches WHERE product_id=$1 ORDER BY id',[id])).rows;
      if(fixture.name.includes('equality'))assert.deepEqual(after,original,'equal batch totals must not alter existing lots');
      if(['aggregate drift','unchanged aggregate drift','historical zero-positive lots','increase'].includes(fixture.name)){
        const unidentified=after.find(row=>row.batch_no==='INVENTORY-COUNT / EXPIRY-UNKNOWN');
        assert.ok(unidentified,'increase must have a traceable inventory count lot');
        assert.equal(unidentified.expiry_date,null);assert.equal(Number(unidentified.unit_cost),0);
      }
    });
    await t.test('large numeric quantities reconcile to the exact thousandth',async()=>{
      const id=await product(10000000000000);const lotId=await batch(id,'10000000000000.001');
      await count(id,10000000000000,10000000000000);
      assert.equal((await client.query('SELECT remaining_quantity FROM inventory_batches WHERE id=$1',[lotId])).rows[0].remaining_quantity,'10000000000000.000');
    });
    await t.test('count rejects excess precision without rounding either ledger',async()=>{
      const id=await product(0);await batch(id,0);
      await assert.rejects(count(id,0,1.0005),error=>error.code==='INVENTORY_COUNT_QUANTITY_INVALID');
      assert.equal(await total(id),0);
      assert.equal((await client.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[id])).rows[0].quantity,'0.000');
    });
    await t.test('canonical count target exactly matches both ledgers and movement across schema range',async()=>{
      for(const target of [1.001,0.029,100000000000000.03,'999999999999999.999']){
        const id=await product(0);await batch(id,0);await count(id,0,target);
        const expected=target===1.001?'1.001':target===0.029?'0.029':target===100000000000000.03?'100000000000000.030':'999999999999999.999';
        const ledger=(await client.query(`SELECT b.quantity,sum(l.remaining_quantity) AS batches,m.quantity AS delta,m.before_quantity,m.after_quantity
          FROM inventory_balances b JOIN inventory_batches l ON l.product_id=b.product_id AND l.store_id=b.store_id AND l.organization_id=b.organization_id
          JOIN stock_movements m ON m.product_id=b.product_id WHERE b.product_id=$1
          GROUP BY b.quantity,m.quantity,m.before_quantity,m.after_quantity`,[id])).rows[0];
        assert.deepEqual(ledger,{quantity:expected,batches:expected,delta:expected,before_quantity:'0.000',after_quantity:expected});
      }
    });
    await t.test('large fractional count delta remains exact and snapshot remains precise',async()=>{
      const id=await product('100000000000000.031');await batch(id,'100000000000000.031');
      await count(id,'100000000000000.031','100000000000000.030');
      const movement=(await client.query('SELECT quantity,before_quantity,after_quantity FROM stock_movements WHERE product_id=$1',[id])).rows[0];
      assert.deepEqual(movement,{quantity:'-0.001',before_quantity:'100000000000000.031',after_quantity:'100000000000000.030'});
      assert.equal((await client.query('SELECT sum(remaining_quantity) AS total FROM inventory_batches WHERE product_id=$1',[id])).rows[0].total,'100000000000000.030');
    });
    await t.test('other-store and other-tenant lots stay unchanged',async()=>{
      const id=await product(5);await batch(id,2);const other=await batch(id,9,{storeId:otherStore});
      const tenantProduct=(await client.query("INSERT INTO products(organization_id,name) VALUES($1,'Other tenant product') RETURNING id",[otherOrg])).rows[0].id;
      const tenant=await batch(tenantProduct,11,{organizationId:otherOrg,storeId:tenantStore});
      await count(id,5,4);assert.equal(await total(id),4);
      assert.equal(Number((await client.query('SELECT remaining_quantity FROM inventory_batches WHERE id=$1',[other])).rows[0].remaining_quantity),9);
      assert.equal(Number((await client.query('SELECT remaining_quantity FROM inventory_batches WHERE id=$1',[tenant])).rows[0].remaining_quantity),11);
    });
    await t.test('deterministic consumption uses expiry then creation then ID',async()=>{
      const id=await product(9);
      const last=await batch(id,2,{expiry:null});
      const b=await batch(id,3,{id:'00000000-0000-4000-8000-000000000002'});
      const a=await batch(id,3,{id:'00000000-0000-4000-8000-000000000001'});
      const older=await batch(id,1,{created:'2025-01-01'});
      await count(id,9,4);
      const quantities=(await client.query('SELECT id,remaining_quantity FROM inventory_batches WHERE product_id=$1',[id])).rows;
      const remaining=new Map(quantities.map(row=>[row.id,Number(row.remaining_quantity)]));
      assert.deepEqual([remaining.get(older),remaining.get(a),remaining.get(b),remaining.get(last)],[0,0,2,2]);
    });
    await t.test('serial inventory is excluded before any batch mutation',async()=>{
      const id=await product(5);await batch(id,2);
      await client.query("INSERT INTO product_serials(organization_id,store_id,product_id,serial) VALUES($1,$2,$3,'count-serial')",[org,store,id]);
      await assert.rejects(count(id,5,7),error=>error.code==='TRACKED_SERIAL_ADJUSTMENT_REQUIRED');
      await count(id,5,5);assert.equal(await total(id),2);
      assert.equal(Number((await client.query('SELECT quantity FROM inventory_balances WHERE product_id=$1',[id])).rows[0].quantity),5);
    });
    // Publish fixtures so another transaction can prove historical rows are locked.
    const historicalProduct=await product(0);const historical=await batch(historicalProduct,0);
    await client.query('COMMIT');transaction=false;
    await client.query('BEGIN');transaction=true;
    await reconcileCountBatches(client,{organizationId:org,storeId:store,productId:historicalProduct,requestedBalance:0});
    await contender.query('BEGIN');contenderTx=true;
    await contender.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(contender.query('SELECT id FROM inventory_batches WHERE id=$1 FOR UPDATE',[historical]),error=>error.code==='55P03');
  }finally{
    if(contenderTx)await contender.query('ROLLBACK').catch(()=>{});
    if(transaction)await client.query('ROLLBACK').catch(()=>{});
    contender?.release();client?.release();await db.end();
  }
});
}

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

integration('admin branch hold serializes against new sale authorization without deleting data',async()=>{
  assertSafeTestDatabaseUrl(integrationUrl,{nodeEnv:process.env.NODE_ENV||'test'});
  const {lockStoreTradingAuthorization}=await import('../src/services/storeTradingHolds.js');
  const db=testPool(3);
  let admin,sale;
  let adminTx=false,saleTx=false;
  try{
    admin=await db.connect();sale=await db.connect();
    const org=(await db.query("INSERT INTO organizations(name,settings,license_status,expiry_date) VALUES('Branch hold rehearsal','{}'::jsonb,'ACTIVE',CURRENT_DATE+30) RETURNING id")).rows[0].id;
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Second store') RETURNING id",[org])).rows[0].id;
    await admin.query('BEGIN');adminTx=true;
    await admin.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[org]);
    await sale.query('BEGIN');saleTx=true;
    await sale.query("SET LOCAL lock_timeout='200ms'");
    await assert.rejects(lockStoreTradingAuthorization(sale,org,store),err=>err?.code==='55P03');
    await sale.query('ROLLBACK');saleTx=false;
    await admin.query("UPDATE organizations SET settings=jsonb_build_object('storeTradingHolds',jsonb_build_object($2::text,jsonb_build_object('reason','billing hold'))) WHERE id=$1",[org,store]);
    await admin.query('COMMIT');adminTx=false;
    await assert.rejects(lockStoreTradingAuthorization(sale,org,store),err=>err?.code==='STORE_TRADING_HOLD');
    // The branch itself and all historical records are untouched.
    const row=(await db.query('SELECT active FROM stores WHERE organization_id=$1 AND id=$2',[org,store])).rows[0];
    assert.equal(row.active,true);
  }finally{
    if(saleTx)await sale.query('ROLLBACK').catch(()=>{});
    if(adminTx)await admin.query('ROLLBACK').catch(()=>{});
    admin?.release();sale?.release();await db.end();
  }
});

registerInventoryCountIntegration();
registerPromoReservationIntegration();
registerStoreAuthorizationIntegration();
registerQueuedRouteIntegration();

integration('expired extra-store entitlement blocks excess branch without archiving existing data',async()=>{
  assertSafeTestDatabaseUrl(integrationUrl,{nodeEnv:process.env.NODE_ENV||'test'});
  const {lockStoreTradingAuthorization}=await import('../src/services/storeTradingHolds.js');
  const db=testPool(2);
  try{
    const org=(await db.query("INSERT INTO organizations(name,store_limit,timezone,license_status,expiry_date) VALUES('Expired entitlement rehearsal',1,'Asia/Tashkent','ACTIVE',CURRENT_DATE+30) RETURNING id")).rows[0].id;
    const first=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Primary') RETURNING id",[org])).rows[0].id;
    const excess=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Paid extra') RETURNING id",[org])).rows[0].id;
    // No active paid extra pass: only the base store may start new operations.
    await lockStoreTradingAuthorization(db,org,first);
    await assert.rejects(lockStoreTradingAuthorization(db,org,excess),err=>err?.code==='STORE_ENTITLEMENT_EXPIRED');
    // A historical paid pass expired yesterday. It must NOT add to quota.
    const paid=(await db.query(`INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,status)
      VALUES($1,$2,'EXTRA','MONTHLY',120000,'APPROVED') RETURNING id`,[org,`expired-pass-${Date.now()}`])).rows[0].id;
    await db.query(`INSERT INTO extra_store_entitlements(organization_id,payment_id,quantity,duration,starts_on,expires_on)
      VALUES($1,$2,1,'MONTHLY',CURRENT_DATE - interval '31 days',CURRENT_DATE - interval '1 day')`,[org,paid]);
    await assert.rejects(lockStoreTradingAuthorization(db,org,excess),err=>err?.code==='STORE_ENTITLEMENT_EXPIRED');
    // An independently paid pass covering today permits use immediately.
    const active=(await db.query(`INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,status)
      VALUES($1,$2,'EXTRA','MONTHLY',120000,'APPROVED') RETURNING id`,[org,`active-pass-${Date.now()}`])).rows[0].id;
    await db.query(`INSERT INTO extra_store_entitlements(organization_id,payment_id,quantity,duration,starts_on,expires_on)
      VALUES($1,$2,1,'MONTHLY',CURRENT_DATE - interval '1 day',CURRENT_DATE + interval '29 days')`,[org,active]);
    await lockStoreTradingAuthorization(db,org,excess);
    assert.equal((await db.query('SELECT active FROM stores WHERE id=$1',[excess])).rows[0].active,true);
  }finally{await db.end();}
});

integration('entitlements have half-open boundaries on the locked local date',async()=>{
  const {lockStoreTradingAuthorization}=await import('../src/services/storeTradingHolds.js');
  const db=testPool(2);
  try{
    const org=(await db.query("INSERT INTO organizations(name,store_limit,timezone,license_status,expiry_date) VALUES('Task 5 boundary',1,'Asia/Tashkent','ACTIVE','2026-10-09') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Primary')",[org]);
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Extra') RETURNING id",[org])).rows[0].id;
    const payment=(await db.query("INSERT INTO billing_payments(organization_id,order_id,type,plan,amount,status) VALUES($1,$2,'EXTRA','MONTHLY',120000,'APPROVED') RETURNING id",[org,`task5-boundary-${org}`])).rows[0].id;
    await db.query("INSERT INTO extra_store_entitlements(organization_id,payment_id,quantity,duration,starts_on,expires_on) VALUES($1,$2,1,'MONTHLY','2026-09-09','2026-10-09')",[org,payment]);
    const input={organizationId:org,storeId:store,now:new Date('2026-10-08T20:00:00Z')};
    await assert.rejects(lockStoreTradingAuthorization(db,input),{code:'STORE_ENTITLEMENT_EXPIRED'});
    await db.query("UPDATE extra_store_entitlements SET starts_on='2026-10-10',expires_on='2026-11-10' WHERE organization_id=$1",[org]);
    await assert.rejects(lockStoreTradingAuthorization(db,input),{code:'STORE_ENTITLEMENT_EXPIRED'});
    await db.query("UPDATE extra_store_entitlements SET starts_on='2026-10-09' WHERE organization_id=$1",[org]);
    const result=await lockStoreTradingAuthorization(db,input);
    assert.equal(result.businessDate,'2026-10-09');assert.equal(result.effectiveStoreLimit,2);
    await assert.rejects(lockStoreTradingAuthorization(db,{...input,now:new Date('2026-10-09T20:00:00Z')}),{code:'LICENSE_EXPIRED'});
  }finally{await db.end();}
});
