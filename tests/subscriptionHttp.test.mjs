import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.SUBSCRIPTION_TEST_DATABASE_URL;
test('HTTP: registration tiers, read-only reads, billing receipts, retries and tenant isolation',{skip:!url,timeout:60000},async t=>{
  assertSafeTestDatabaseUrl(url);assert.equal(process.env.DATABASE_URL,url);
  const savedMode=process.env.TRIAL_PHONE_VERIFICATION_MODE,savedUntil=process.env.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL;
  process.env.TRIAL_PHONE_VERIFICATION_MODE='temporary_disabled';process.env.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL=new Date(Date.now()+3600000).toISOString();
  const {app}=await import('../src/app.js');const db=new pg.Pool({connectionString:url});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,{method='GET',cookie,body,raw=false}={})=>{
    const r=await fetch(base+path,{method,headers:{'content-type':raw?'image/png':'application/json','x-zenix-client':'web','x-forwarded-for':`198.18.${randomInt(1,254)}.${randomInt(1,254)}`,...(cookie?{cookie}:{})},body:body===undefined?undefined:raw?body:JSON.stringify(body)});
    return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],...(await r.json())};
  };
  const accounts=[];
  try{
    await t.test('all three registrations get chosen tier and exactly one 14-day trial',async()=>{
      for(const planCode of ['START','BUSINESS','PREMIUM']){
        const result=await request('/api/auth/register',{method:'POST',body:{businessName:'Tier HTTP test',ownerName:'Owner',phone:'99890'+randomInt(1000000,9999999),username:randomUUID(),password:randomUUID()+'Aa1!',planCode,billingInterval:'MONTHLY',amount:1,licenseStatus:'ACTIVE'}});
        assert.equal(result.status,201,JSON.stringify(result));const orgId=result.data.user.organizationId;
        const org=(await db.query('SELECT * FROM organizations WHERE id=$1',[orgId])).rows[0];
        assert.equal(org.plan_code,planCode);assert.equal(Date.parse(org.settings.trialEndsAt)-Date.parse(org.settings.trialStartedAt),14*86400000);
        accounts.push({orgId,cookie:result.cookie});
        const state=await request('/api/billing/subscription',{cookie:result.cookie});assert.equal(state.data.subscription.billingInterval,null);
      }
    });
    const a=accounts[0],b=accounts[1];
    await t.test('previously-used trial phone can choose paid onboarding without a billing interval',async()=>{
      const phone=(await db.query('SELECT phone FROM organizations WHERE id=$1',[a.orgId])).rows[0].phone;
      const body={businessName:'Paid onboarding',ownerName:'Owner',phone,username:randomUUID(),password:randomUUID()+'Aa1!',planCode:'START',startOption:'PAID'};
      const result=await request('/api/auth/register',{method:'POST',body});assert.equal(result.status,201,JSON.stringify(result));
      const org=(await db.query('SELECT * FROM organizations WHERE id=$1',[result.data.user.organizationId])).rows[0];assert.equal(org.license_status,'PAYMENT_REQUIRED');assert.equal(org.plan_code,'START');assert.equal(org.settings.trialEndsAt,undefined);
      const state=await request('/api/billing/subscription',{cookie:result.cookie});assert.equal(state.data.subscription.billingInterval,null);assert.equal(state.data.subscription.accessMode,'READ_ONLY');
    });
    await t.test('trial change does not reset deadline and cross tenant changes are impossible',async()=>{
      const before=(await db.query('SELECT settings FROM organizations WHERE id=$1',[a.orgId])).rows[0];
      const changed=await request('/api/billing/trial-plan',{method:'POST',cookie:a.cookie,body:{planCode:'BUSINESS'}});assert.equal(changed.status,200);
      assert.equal(changed.data.subscription.trialEndsAt,before.settings.trialEndsAt);
      const spoof=await request('/api/billing/trial-plan',{method:'POST',cookie:a.cookie,body:{planCode:'PREMIUM',organizationId:b.orgId}});assert.equal(spoof.status,400);
    });
    const product=await request('/api/products',{method:'POST',cookie:a.cookie,body:{name:'HTTP retained product',sellPrice:1000}});assert.equal(product.status,201,JSON.stringify(product));
    const productId=product.data.product.id;
    const storeId=(await db.query('SELECT id FROM stores WHERE organization_id=$1',[a.orgId])).rows[0].id;
    await t.test('expired trial retains GET data and blocks every business write before validation',async()=>{
      await db.query("UPDATE organizations SET settings=jsonb_set(settings,'{trialEndsAt}','\"2020-01-01T00:00:00Z\"'::jsonb),expiry_date='2020-01-01' WHERE id=$1",[a.orgId]);
      for(const path of ['/api/products',`/api/sales/page?storeId=${storeId}`,'/api/finance','/api/customers','/api/audit',`/api/warehouses?storeId=${storeId}`,'/api/bootstrap','/api/billing/subscription']){
        const response=await request(path,{cookie:a.cookie});assert.equal(response.status,200,path+JSON.stringify(response));
        if(path==='/api/bootstrap'){assert.equal(response.data.organization.accessMode,'READ_ONLY');assert.ok(response.data.inventory.some(x=>x.id===productId));}
      }
      for(const [method,path] of [['POST','/api/sales'],['POST','/api/inventory/receive'],['POST','/api/warehouses'],['POST','/api/users'],['PATCH','/api/settings/workspace'],['PATCH','/api/users/me/profile'],['POST','/api/files'],['DELETE',`/api/products/${productId}`]]){
        const response=await request(path,{method,cookie:a.cookie,body:{}});assert.equal(response.status,402,path+JSON.stringify(response));
      }
      assert.equal((await request('/api/settings/preferences',{method:'PATCH',cookie:a.cookie,body:{uiPreferences:{theme:'dark'}}})).status,200);
      const foreign=await request(`/api/products/${productId}`,{method:'PATCH',cookie:b.cookie,body:{name:'Stolen'}});assert.equal(foreign.status,404);
    });
    await t.test('billing accepts tenant-owned evidence only; retries submit one review without activating',async()=>{
      const draft=await request('/api/billing/draft',{method:'POST',cookie:a.cookie,body:{type:'LICENSE',planCode:'PREMIUM',billingInterval:'MONTHLY',amount:1,status:'APPROVED',metadata:{subscription:{creditAmount:'999999'}}}});
      assert.equal(draft.status,201,JSON.stringify(draft));assert.equal(draft.data.draft.totalAmount,590000);
      const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
      const other=await request('/api/billing/receipts',{method:'POST',cookie:b.cookie,body:bytes,raw:true});assert.equal(other.status,201);
      const foreign=await request('/api/billing/payments',{method:'POST',cookie:a.cookie,body:{draftId:draft.data.draft.id,receiptId:other.data.receipt.id}});assert.equal(foreign.status,404);
      const receipt=await request('/api/billing/receipts',{method:'POST',cookie:a.cookie,body:bytes,raw:true});assert.equal(receipt.status,201);
      const body={draftId:draft.data.draft.id,receiptId:receipt.data.receipt.id};
      const submitted=await Promise.all([1,2].map(()=>request('/api/billing/payments',{method:'POST',cookie:a.cookie,body})));
      assert.ok(submitted.every(x=>x.status===201),JSON.stringify(submitted));assert.equal(submitted[0].data.payment.id,submitted[1].data.payment.id);
      assert.equal((await db.query('SELECT plan_code FROM organizations WHERE id=$1',[a.orgId])).rows[0].plan_code,'BUSINESS');
      const state=await request('/api/billing/subscription',{cookie:a.cookie});assert.equal(state.data.subscription.accessMode,'READ_ONLY');
    });
    await t.test('100% promo needs no fake receipt and a retry never grants a second term',async()=>{
      const account=accounts[2],code='HTTP-'+randomUUID().slice(0,12).toUpperCase();
      await db.query('INSERT INTO platform_promos(code,discount_percent,max_uses) VALUES($1,100,1)',[code]);
      const draft=await request('/api/billing/draft',{method:'POST',cookie:account.cookie,body:{type:'LICENSE',planCode:'PREMIUM',billingInterval:'MONTHLY',promoCode:code}});
      assert.equal(draft.status,201,JSON.stringify(draft));assert.equal(draft.data.draft.totalAmount,0);
      const body={draftId:draft.data.draft.id};
      const first=await request('/api/billing/payments',{method:'POST',cookie:account.cookie,body});assert.equal(first.status,201,JSON.stringify(first));assert.equal(first.data.payment.status,'APPROVED');
      const retry=await request('/api/billing/payments',{method:'POST',cookie:account.cookie,body});assert.equal(retry.status,201);assert.equal(retry.data.payment.id,first.data.payment.id);
      assert.equal((await db.query('SELECT count(*) count FROM subscription_terms WHERE payment_id=$1',[first.data.payment.id])).rows[0].count,'1');
      assert.equal((await db.query('SELECT used_count FROM platform_promos WHERE code=$1',[code])).rows[0].used_count,1);
    });
    await t.test('expiration committed while a sale/product transaction waits for org lock denies the write',async()=>{
      const account=accounts[2],locked=await db.connect();let pending;
      const count=Number((await db.query('SELECT count(*) count FROM products WHERE organization_id=$1',[account.orgId])).rows[0].count);
      try{
        await locked.query('BEGIN');await locked.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[account.orgId]);
        pending=request('/api/products',{method:'POST',cookie:account.cookie,body:{name:'Must not pass the lock wait'}});
        let waiting=false;
        for(let attempt=0;attempt<100;attempt++){
          waiting=Boolean((await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM organizations WHERE id=$1 FOR UPDATE%' LIMIT 1")).rows[0]);
          if(waiting)break;await new Promise(r=>setTimeout(r,10));
        }
        assert.equal(waiting,true,'request must first pass auth and wait on the organization lock');
        await locked.query("UPDATE organizations SET license_status='EXPIRED' WHERE id=$1",[account.orgId]);await locked.query('COMMIT');
        const response=await pending;assert.equal(response.status,402,JSON.stringify(response));
        assert.equal(Number((await db.query('SELECT count(*) count FROM products WHERE organization_id=$1',[account.orgId])).rows[0].count),count);
      }finally{await locked.query('ROLLBACK');locked.release();if(pending)await pending;}
    });
  }finally{
    await new Promise(r=>server.close(r));await db.end();const {pool}=await import('../src/db/pool.js');await pool.end();
    if(savedMode===undefined)delete process.env.TRIAL_PHONE_VERIFICATION_MODE;else process.env.TRIAL_PHONE_VERIFICATION_MODE=savedMode;
    if(savedUntil===undefined)delete process.env.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL;else process.env.TRIAL_PHONE_VERIFICATION_DISABLED_UNTIL=savedUntil;
  }
});
