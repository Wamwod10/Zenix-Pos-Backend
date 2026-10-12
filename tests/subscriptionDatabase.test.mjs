import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {runTransaction} from '../src/db/tx.js';
import {quoteSubscription,changeTrialPlan,scheduleDowngrade,billingDay,nextDay,previousDay} from '../src/services/subscriptions.js';
import {addMonths} from '../src/config/billing.js';
import {SUBSCRIPTION_CATALOG} from '../src/config/subscriptions.js';
import {databaseDateISO} from '../src/lib/businessDate.js';
import {lockStoreTradingAuthorization} from '../src/services/storeTradingHolds.js';
import {applyOrganizationControl} from '../src/services/platformOrganization.js';
import {calculateDraft} from '../src/routes/billing.js';
import {applyBillingReview} from '../src/services/billingReview.js';
const url=process.env.SUBSCRIPTION_TEST_DATABASE_URL;

test('subscription migration, billing, read-only and concurrent approval on isolated PostgreSQL',{skip:!url,timeout:60000},async t=>{
  assertSafeTestDatabaseUrl(url);const db=new pg.Pool({connectionString:url,max:8});
  const createOrg=async(values={})=>{
    const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,settings,plan_code) VALUES('Subscription test',$1,$2,$3,$4) RETURNING *",[values.status||'ACTIVE',values.expiry||'2099-01-01',values.settings||{},values.code||'BUSINESS'])).rows[0];
    const user=(await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Owner',$2,'test','OWNER') RETURNING *",[org.id,randomUUID()])).rows[0];
    return {org,user};
  };
  const checkout=async(org,user,input)=>runTransaction(db,async c=>{
    const calculated=await calculateDraft(c,{organizationId:org.id,id:user.id},{type:'LICENSE',extraStoreCount:0,metadata:{},...input});
    const {buildBillingDraftMetadata}=await import('../src/services/billingDraftMetadata.js');
    const draft=(await c.query(`INSERT INTO billing_drafts(order_id,organization_id,created_by,type,plan,current_end_date,selected_end_date,base_amount,total_amount,metadata,status)
      VALUES($1,$2,$3,'LICENSE',$4,$5,$6,$7,$8,$9,'submitted') RETURNING *`,[randomUUID(),org.id,user.id,calculated.plan,calculated.currentEndDate,calculated.selectedEndDate,calculated.baseAmount,calculated.totalAmount,buildBillingDraftMetadata({metadata:{}},calculated)])).rows[0];
    const payment=(await c.query(`INSERT INTO billing_payments(organization_id,draft_id,order_id,type,plan,amount,service_period_from,service_period_to,submitted_by)
      VALUES($1,$2,$3,'LICENSE',$4,$5,$6,$7,$8) RETURNING *`,[org.id,draft.id,draft.order_id,calculated.plan,calculated.totalAmount,calculated.currentEndDate,calculated.selectedEndDate,user.id])).rows[0];
    const {reservePromo}=await import('../src/services/promoCodes.js');await reservePromo(c,{paymentId:payment.id,organizationId:org.id});
    return {payment,draft,calculated};
  });
  const approve=payment=>runTransaction(db,c=>applyBillingReview(c,{paymentId:payment.id,decision:'APPROVED'}));
  try{
    await t.test('033 is repeatable and preserves existing financial records',async()=>{
      const before=(await db.query('SELECT count(*) count,COALESCE(sum(amount),0) amount FROM billing_payments')).rows[0];
      const sql=await fs.readFile(new URL('../migrations/033_subscription_billing.sql',import.meta.url),'utf8');
      await runTransaction(db,c=>c.query(sql));await runTransaction(db,c=>c.query(sql));
      assert.deepEqual((await db.query('SELECT count(*) count,COALESCE(sum(amount),0) amount FROM billing_payments')).rows[0],before);
      for(const row of (await db.query('SELECT * FROM subscription_plan_versions ORDER BY plan_code')).rows){
        const plan=SUBSCRIPTION_CATALOG[row.version][row.plan_code];assert.equal(Number(row.monthly_amount),plan.prices.MONTHLY);assert.equal(Number(row.annual_amount),plan.prices.ANNUAL);assert.deepEqual(row.limits,plan.limits);
      }
    });
    await t.test('trial plan changes preserve exactly the original expiry',async()=>{
      const deadline=new Date(Date.now()+86400000).toISOString();const {org,user}=await createOrg({settings:{trialEndsAt:deadline,trialUsed:true}});
      await runTransaction(db,c=>changeTrialPlan(c,{organizationId:org.id,userId:user.id,planCode:'START'}));
      const row=(await db.query('SELECT * FROM organizations WHERE id=$1',[org.id])).rows[0];
      assert.equal(row.settings.trialEndsAt,deadline);assert.equal(row.plan_code,'START');assert.equal(row.store_limit,1);
    });
    await t.test('expired tenant cannot write sale/warehouse/product rows even after middleware',async()=>{
      const {org}=await createOrg();const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Main') RETURNING *",[org.id])).rows[0];
      await db.query("UPDATE organizations SET expiry_date='2020-01-01',legacy_expiry_date=NULL WHERE id=$1",[org.id]);
      for(const [sql,args] of [
        ["INSERT INTO products(organization_id,name) VALUES($1,'Blocked')",[org.id]],
        ["INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,'Blocked')",[org.id,store.id]],
        ["INSERT INTO sales(organization_id,store_id,sale_number) VALUES($1,$2,$3)",[org.id,store.id,randomUUID()]],
      ])await assert.rejects(()=>db.query(sql,args),error=>error.code==='ZX402');
      assert.equal((await db.query('SELECT count(*) count FROM stores WHERE organization_id=$1',[org.id])).rows[0].count,'1');
    });
    await t.test('Start product 750 boundary is serialized and includes inventory-created products',async()=>{
      const {org}=await createOrg({code:'START'});
      await db.query("INSERT INTO products(organization_id,name) SELECT $1,'Product '||i FROM generate_series(1,749) i",[org.id]);
      const result=await Promise.allSettled([1,2].map(i=>db.query('INSERT INTO products(organization_id,name) VALUES($1,$2)',[org.id,'Last '+i])));
      assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(result.filter(x=>x.status==='rejected'&&x.reason.code==='ZX409').length,1);
      assert.equal((await db.query('SELECT count(*) count FROM products WHERE organization_id=$1',[org.id])).rows[0].count,'750');
    });
    await t.test('new quote uses server tariff; review pending does not activate; duplicate approval is atomic',async()=>{
      const {org,user}=await createOrg({code:'START',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      const actor={organizationId:org.id,id:user.id};
      const calculated=await runTransaction(db,c=>calculateDraft(c,actor,{type:'LICENSE',planCode:'PREMIUM',billingInterval:'MONTHLY',intent:'ACTIVATE',extraStoreCount:0,metadata:{subscription:{planCode:'START',creditAmount:'999999'}}}));
      assert.equal(calculated.baseAmount,590000);
      const {buildBillingDraftMetadata}=await import('../src/services/billingDraftMetadata.js');
      const draft=(await db.query(`INSERT INTO billing_drafts(order_id,organization_id,created_by,type,plan,current_end_date,selected_end_date,base_amount,total_amount,metadata,status)
        VALUES($1,$2,$3,'LICENSE','MONTHLY',$4,$5,$6,$6,$7,'submitted') RETURNING *`,[randomUUID(),org.id,user.id,calculated.currentEndDate,calculated.selectedEndDate,calculated.totalAmount,buildBillingDraftMetadata({metadata:{}},calculated)])).rows[0];
      const p=(await db.query(`INSERT INTO billing_payments(organization_id,draft_id,order_id,type,plan,amount,service_period_from,service_period_to,submitted_by)
        VALUES($1,$2,$3,'LICENSE','MONTHLY',$4,$5,$6,$7) RETURNING *`,[org.id,draft.id,draft.order_id,calculated.totalAmount,calculated.currentEndDate,calculated.selectedEndDate,user.id])).rows[0];
      assert.equal((await db.query('SELECT plan_code FROM organizations WHERE id=$1',[org.id])).rows[0].plan_code,'START');
      const results=await Promise.all([1,2].map(()=>runTransaction(db,c=>applyBillingReview(c,{paymentId:p.id,decision:'APPROVED'}))));
      assert.deepEqual(results.map(r=>r.outcome).sort(),['alreadyReviewed','approved']);
      assert.equal((await db.query('SELECT plan_code FROM organizations WHERE id=$1',[org.id])).rows[0].plan_code,'PREMIUM');
      assert.equal((await db.query('SELECT count(*) count FROM subscription_terms WHERE payment_id=$1',[p.id])).rows[0].count,'1');
    });
    await t.test('renewal preserves current plan/interval; upgrade uses all real paid remaining value',async()=>{
      const {org,user}=await createOrg({code:'START',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      const first=await checkout(org,user,{planCode:'START',billingInterval:'MONTHLY'});await approve(first.payment);
      const renewal=await checkout(org,user,{planCode:'START',billingInterval:'ANNUAL',intent:'RENEW'});await approve(renewal.payment);
      const state=(await db.query('SELECT * FROM organizations WHERE id=$1',[org.id])).rows[0];assert.equal(state.plan,'MONTHLY');
      const upgrade=await checkout(org,user,{planCode:'PREMIUM',billingInterval:'ANNUAL',intent:'CHANGE_PLAN'});
      assert.equal(upgrade.calculated.subscription.creditAmount,'2750000.00');assert.equal(upgrade.calculated.totalAmount,3150000);
      await approve(upgrade.payment);
      assert.equal((await db.query('SELECT count(*) count FROM subscription_terms WHERE organization_id=$1 AND superseded_at IS NOT NULL',[org.id])).rows[0].count,'2');
      assert.equal((await db.query('SELECT sum(value_amount) value FROM subscription_terms WHERE organization_id=$1 AND superseded_at IS NULL',[org.id])).rows[0].value,'5900000.00');
    });
    await t.test('downgrade stays scheduled until paid end and cannot revive a completed change by cancelling',async()=>{
      const {org,user}=await createOrg({code:'PREMIUM',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      await approve((await checkout(org,user,{planCode:'PREMIUM',billingInterval:'MONTHLY'})).payment);
      await runTransaction(db,c=>scheduleDowngrade(c,{organizationId:org.id,userId:user.id,planCode:'START'}));
      assert.equal((await db.query('SELECT subscription_effective_plan($1) code',[org.id])).rows[0].code,'PREMIUM');
      await db.query('UPDATE organizations SET subscription_change_on=$2 WHERE id=$1',[org.id,billingDay()]);
      assert.equal((await db.query('SELECT subscription_effective_plan($1) code',[org.id])).rows[0].code,'START');
      await assert.rejects(()=>runTransaction(db,c=>scheduleDowngrade(c,{organizationId:org.id,userId:user.id,cancel:true})),{code:'CHANGE_ALREADY_EFFECTIVE'});
    });
    await t.test('delayed upgrade review leaves REVIEW and all credit/terms unchanged',async()=>{
      const {org,user}=await createOrg({code:'START',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      await approve((await checkout(org,user,{planCode:'START',billingInterval:'MONTHLY'})).payment);
      const upgrade=await checkout(org,user,{planCode:'BUSINESS',billingInterval:'MONTHLY'});
      await db.query("UPDATE billing_drafts SET metadata=jsonb_set(metadata,'{subscription,pricingDay}',to_jsonb($2::text)) WHERE id=$1",[upgrade.draft.id,previousDay(billingDay())]);
      await assert.rejects(()=>approve(upgrade.payment),{code:'SUBSCRIPTION_QUOTE_STALE'});
      assert.equal((await db.query('SELECT status FROM billing_payments WHERE id=$1',[upgrade.payment.id])).rows[0].status,'REVIEW');
      assert.equal((await db.query('SELECT plan_code FROM organizations WHERE id=$1',[org.id])).rows[0].plan_code,'START');
      assert.equal((await db.query('SELECT count(*) count FROM subscription_terms WHERE organization_id=$1 AND superseded_at IS NOT NULL',[org.id])).rows[0].count,'0');
    });
    await t.test('free promo receives zero upgrade credit and cannot be reserved by two tenants',async()=>{
      const code='SUB-'+randomUUID().slice(0,12).toUpperCase();await db.query("INSERT INTO platform_promos(code,discount_percent,max_uses,max_uses_per_org) VALUES($1,100,1,1)",[code]);
      const a=await createOrg({code:'START',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}}),b=await createOrg({code:'START',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      const results=await Promise.allSettled([a,b].map(({org,user})=>checkout(org,user,{planCode:'START',billingInterval:'MONTHLY',promoCode:code})));
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='PROMO_EXHAUSTED').length,1);
      const winner=results.find(x=>x.status==='fulfilled').value;await approve(winner.payment);
      const row=(await db.query('SELECT * FROM organizations WHERE id=$1',[winner.payment.organization_id])).rows[0];
      const quote=await runTransaction(db,c=>quoteSubscription(c,row,{planCode:'BUSINESS',billingInterval:'MONTHLY'}));
      assert.equal(quote.creditAmount,'0.00');assert.equal(quote.baseAmount,350000);
    });
    await t.test('completed upgrade clears a pending downgrade instead of downgrading again later',async()=>{
      const {org,user}=await createOrg({code:'BUSINESS',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      await approve((await checkout(org,user,{planCode:'BUSINESS',billingInterval:'MONTHLY'})).payment);
      await runTransaction(db,c=>scheduleDowngrade(c,{organizationId:org.id,userId:user.id,planCode:'START'}));
      await approve((await checkout(org,user,{planCode:'PREMIUM',billingInterval:'MONTHLY'})).payment);
      assert.equal((await db.query('SELECT subscription_pending_plan FROM organizations WHERE id=$1',[org.id])).rows[0].subscription_pending_plan,null);
    });
    await t.test('annual credit above a monthly upgrade price stays in the wallet and is never paid out',async()=>{
      const {org,user}=await createOrg({code:'BUSINESS',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      await approve((await checkout(org,user,{planCode:'BUSINESS',billingInterval:'ANNUAL'})).payment);
      const change=await checkout(org,user,{planCode:'PREMIUM',billingInterval:'MONTHLY'});assert.equal(change.calculated.totalAmount,0);
      assert.equal(change.calculated.subscription.remainingCredit,'2710000.00');await approve(change.payment);
      const state=(await db.query('SELECT subscription_credit FROM organizations WHERE id=$1',[org.id])).rows[0];assert.equal(state.subscription_credit,'2710000.00');
    });
    await t.test('delayed activation starts a full calendar term at approval and returns that trusted period',async()=>{
      const {org,user}=await createOrg({code:'START',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      const order=await checkout(org,user,{planCode:'START',billingInterval:'MONTHLY'});
      const start=previousDay(billingDay()),end=addMonths(start,1);
      await db.query("UPDATE billing_drafts SET metadata=jsonb_set(jsonb_set(metadata,'{subscription,startsOn}',to_jsonb($2::text)),'{subscription,endsOn}',to_jsonb($3::text)) WHERE id=$1",[order.draft.id,start,end]);
      await db.query('UPDATE billing_payments SET service_period_from=$2,service_period_to=$3 WHERE id=$1',[order.payment.id,start,previousDay(end)]);
      const result=await approve(order.payment);
      assert.equal((await db.query('SELECT starts_on::text,ends_on::text FROM subscription_terms WHERE payment_id=$1',[order.payment.id])).rows[0].starts_on,billingDay());
      assert.equal(databaseDateISO(result.payment.service_period_from),billingDay());
    });
    await t.test('an old permanent store allowance survives explicit tier conversion',async()=>{
      const {org,user}=await createOrg({settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      await db.query('UPDATE organizations SET plan_code=NULL,store_limit=4 WHERE id=$1',[org.id]);
      await approve((await checkout(org,user,{planCode:'START',billingInterval:'MONTHLY'})).payment);
      const row=(await db.query('SELECT store_limit,legacy_store_bonus FROM organizations WHERE id=$1',[org.id])).rows[0];assert.equal(row.store_limit,3);assert.equal(row.legacy_store_bonus,2);
    });
    await t.test('Tashkent terms stay writable through final day even when reporting timezone is next day',async t=>{
      t.mock.timers.enable({apis:['Date'],now:new Date(`${billingDay()}T14:00:00Z`)});
      const {org,user}=await createOrg({code:'START',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      await approve((await checkout(org,user,{planCode:'START',billingInterval:'MONTHLY'})).payment);
      await db.query('UPDATE subscription_terms SET starts_on=$2,ends_on=$3 WHERE organization_id=$1',[org.id,previousDay(billingDay()),nextDay(billingDay())]);
      await db.query("UPDATE organizations SET timezone='Pacific/Kiritimati',expiry_date=$2 WHERE id=$1",[org.id,billingDay()]);
      await runTransaction(db,c=>lockStoreTradingAuthorization(c,{organizationId:org.id}));
      const renewal=await checkout(org,user,{planCode:'START',billingInterval:'MONTHLY',intent:'RENEW'});
      await runTransaction(db,c=>applyBillingReview(c,{paymentId:renewal.payment.id,decision:'REJECTED'}));
      assert.equal((await db.query('SELECT license_status FROM organizations WHERE id=$1',[org.id])).rows[0].license_status,'ACTIVE');
      await runTransaction(db,c=>applyOrganizationControl(c,{organizationId:org.id,actorId:user.id,input:{action:'SUSPEND',reason:'Disposable test suspension'}}));
      await runTransaction(db,c=>applyOrganizationControl(c,{organizationId:org.id,actorId:user.id,input:{action:'RESTORE',reason:'Disposable test restoration'}}));
      assert.equal((await db.query('SELECT license_status FROM organizations WHERE id=$1',[org.id])).rows[0].license_status,'ACTIVE');
      await assert.rejects(()=>runTransaction(db,c=>applyOrganizationControl(c,{organizationId:org.id,actorId:user.id,input:{action:'SET_LICENSE',reason:'Disposable unsupported override',plan:'ANNUAL',expiryDate:'2099-01-01',storeLimit:3}})),{code:'TIER_LICENSE_OVERRIDE_UNSUPPORTED'});
    });
    await t.test('paid future downgrade term cannot be cancelled or replaced by changing schedule flags',async()=>{
      const {org,user}=await createOrg({code:'PREMIUM',settings:{trialEndsAt:new Date(Date.now()+86400000).toISOString()}});
      await approve((await checkout(org,user,{planCode:'PREMIUM',billingInterval:'MONTHLY'})).payment);
      await runTransaction(db,c=>scheduleDowngrade(c,{organizationId:org.id,userId:user.id,planCode:'START'}));
      await approve((await checkout(org,user,{planCode:'START',billingInterval:'MONTHLY',intent:'RENEW'})).payment);
      for(const input of [{cancel:true},{planCode:'BUSINESS'}])await assert.rejects(()=>runTransaction(db,c=>scheduleDowngrade(c,{organizationId:org.id,userId:user.id,...input})),{code:'FUNDED_DOWNGRADE_CONFLICT'});
    });
  }finally{await db.end()}
});
