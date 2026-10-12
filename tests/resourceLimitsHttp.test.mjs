import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.RESOURCE_TEST_DATABASE_URL;
test('resource HTTP: tenant scope, permissions, active employee login, POS registration and read-only',{skip:!url,timeout:30000},async t=>{
  assertSafeTestDatabaseUrl(url);assert.equal(process.env.DATABASE_URL,url);
  const [{app},{pool},{sha256},{default:bcrypt}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/lib/crypto.js'),import('bcryptjs')]);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,token,method='GET',body)=>{
    const response=await fetch(base+path,{method,headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:`zenix_session=${token||''}`},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  };
  const expect=(result,status)=>{assert.equal(result.status,status,JSON.stringify(result));return result.data};
  try{
    const org=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('HTTP limits','START','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
    const other=(await pool.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Foreign','BUSINESS','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
    const store=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Main') RETURNING id",[org])).rows[0].id;
    const otherStore=(await pool.query("INSERT INTO stores(organization_id,name) VALUES($1,'Foreign') RETURNING id",[other])).rows[0].id;
    const users={};
    for(const role of ['OWNER','ADMIN','CASHIER']){
      const username=randomUUID(),password='TestPass123!';
      const user=(await pool.query('INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,$3,$4,$5,$3) RETURNING id',[org,role==='CASHIER'?store:null,role,username,await bcrypt.hash(password,4)])).rows[0].id;
      const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,sha256(token)]);users[role]={id:user,token,username,password};
    }
    const owner=users.OWNER.token,cashier=users.CASHIER.token;
    await t.test('public registration catalog and business-wide structured limits',async()=>{
      const config=expect(await request('/api/auth/registration-config'),200);assert.equal(config.plans.length,3);assert.equal(config.plans[0].limits.products,750);
      const data=expect(await request('/api/billing/limits',owner),200);assert.equal(data.resources.employees.used,2);assert.equal(data.resources.stores.used,1);assert.equal(data.resources.warehouses.used,1);
      expect(await request('/api/billing/limits',cashier),403);
      const result=await request('/api/stores',owner,'POST',{name:'Over limit'});expect(result,409);assert.equal(result.error.code,'STORE_LIMIT');assert.equal(result.error.details.used,1);
      const employee=await request('/api/users',owner,'POST',{name:'Extra',phone:'998900000001',username:randomUUID(),password:'TestPass123!',appRole:'ADMIN'});expect(employee,409);assert.equal(employee.error.code,'EMPLOYEE_LIMIT');
    });
    let register;
    await t.test('POS registration is role/tenant scoped and parallel active growth cannot bypass cap',async()=>{
      expect(await request('/api/registers',cashier,'POST',{storeId:store,name:'Forbidden'}),403);
      expect(await request('/api/registers',owner,'POST',{storeId:otherStore,name:'Foreign'}),404);
      const results=await Promise.all([1,2].map(n=>request('/api/registers',owner,'POST',{storeId:store,name:`POS ${n}`})));
      assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);register=results.find(r=>r.status===201).data.register;
      expect(await request(`/api/registers?storeId=${otherStore}`,owner),404);
      const list=expect(await request(`/api/registers?storeId=${store}`,cashier),200).registers;assert.equal(list.length,1);
      const spare=expect(await request('/api/registers',owner,'POST',{storeId:store,name:'Inactive spare',active:false}),201).register;
      const result=await request(`/api/registers/${spare.id}`,owner,'PATCH',{active:true});expect(result,409);assert.equal(result.error.code,'REGISTER_LIMIT');
    });
    await t.test('registered shift binds genuine POS, open shift blocks deactivation and owner stays protected',async()=>{
      const shift=expect(await request('/api/shifts/open',cashier,'POST',{storeId:store,registerId:register.id}),201).shift;assert.equal(shift.register_id,register.id);
      const result=await request(`/api/registers/${register.id}`,owner,'PATCH',{active:false});expect(result,409);assert.equal(result.error.code,'REGISTER_HAS_OPEN_SHIFT');
      expect(await request(`/api/users/${users.OWNER.id}`,owner,'PATCH',{active:false}),400);
    });
    await t.test('inactive employee loses current session and cannot login, history remains',async()=>{
      expect(await request(`/api/users/${users.ADMIN.id}`,owner,'PATCH',{active:false}),200);
      expect(await request('/api/auth/me',users.ADMIN.token),401);
      expect(await request('/api/auth/login',null,'POST',{username:users.ADMIN.username,password:users.ADMIN.password}),401);
      assert.equal((await pool.query('SELECT count(*)::int n FROM users WHERE id=$1',[users.ADMIN.id])).rows[0].n,1);
    });
    await t.test('expired subscription preserves resource reads and billing but blocks mutations',async()=>{
      await pool.query("UPDATE organizations SET expiry_date='2000-01-01' WHERE id=$1",[org]);
      expect(await request('/api/registers',owner),200);expect(await request('/api/billing/limits',owner),200);expect(await request('/api/billing/subscription',owner),200);
      expect(await request(`/api/registers/${register.id}`,owner,'PATCH',{name:'Read-only write'}),402);
      expect(await request('/api/stores',owner,'POST',{name:'Readonly'}),402);
    });
    await t.test('restoring a stale quote cancels it before exposing transfer instructions',async()=>{
      const draft=expect(await request('/api/billing/draft',owner,'POST',{type:'LICENSE',planCode:'START',billingInterval:'MONTHLY'}),201).draft;
      await pool.query('UPDATE organizations SET subscription_version=subscription_version+1 WHERE id=$1',[org]);
      const data=expect(await request('/api/billing/draft',owner),200);assert.equal(data.draft,null);assert.equal(data.stale,true);
      assert.equal((await pool.query('SELECT status FROM billing_drafts WHERE id=$1',[draft.id])).rows[0].status,'cancelled');
    });
    await t.test('fractional credit plus 100% promo yields exactly zero and one approved paid term',async()=>{
      await pool.query('UPDATE organizations SET subscription_credit=249999.35 WHERE id=$1',[org]);
      const code='DEC-'+randomUUID().slice(0,8).toUpperCase();await pool.query('INSERT INTO platform_promos(code,discount_percent,max_uses) VALUES($1,100,1)',[code]);
      const draft=expect(await request('/api/billing/draft',owner,'POST',{type:'LICENSE',planCode:'START',billingInterval:'MONTHLY',promoCode:code}),201).draft;
      assert.equal(draft.baseAmount,0.65);assert.equal(draft.metadata.promoDiscount,0.65);assert.equal(draft.totalAmount,0);
      const body={draftId:draft.id};const results=await Promise.all([1,2].map(()=>request('/api/billing/payments',owner,'POST',body)));
      for(const result of results)assert.equal(expect(result,201).payment.status,'APPROVED');
      assert.equal((await pool.query('SELECT count(*)::int n FROM subscription_terms WHERE organization_id=$1',[org])).rows[0].n,1);
    });
    await t.test('fractional upgrade with partial promo reserves exact money and approves allocated value',async()=>{
      const code='HALF-'+randomUUID().slice(0,8).toUpperCase();await pool.query('INSERT INTO platform_promos(code,discount_percent,max_uses) VALUES($1,50,1)',[code]);
      const draft=expect(await request('/api/billing/draft',owner,'POST',{type:'LICENSE',planCode:'BUSINESS',billingInterval:'MONTHLY',promoCode:code}),201).draft;
      assert.equal(draft.baseAmount,100000.65);assert.equal(draft.metadata.promoDiscount,50000.33);assert.equal(draft.totalAmount,50000.32);
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lAAAAABJRU5ErkJggg==','base64');
      const response=await fetch(base+'/api/billing/receipts',{method:'POST',headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'image/png','x-file-name':'partial.png',cookie:`zenix_session=${owner}`},body:png});assert.equal(response.status,201);
      const receipt=(await response.json()).data.receipt;
      const payment=expect(await request('/api/billing/payments',owner,'POST',{draftId:draft.id,receiptId:receipt.id}),201).payment;assert.equal(payment.status,'REVIEW');
      const {applyBillingReview}=await import('../src/services/billingReview.js');const client=await pool.connect();
      try{await client.query('BEGIN');await applyBillingReview(client,{paymentId:payment.id,decision:'APPROVED',actor:{id:users.OWNER.id,appRole:'OWNER'}});await client.query('COMMIT')}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
      const term=(await pool.query('SELECT value_amount::text FROM subscription_terms WHERE payment_id=$1',[payment.id])).rows[0];assert.equal(term.value_amount,'299999.67');
      assert.equal((await pool.query('SELECT discount_amount::text FROM platform_promo_uses WHERE payment_id=$1',[payment.id])).rows[0].discount_amount,'50000.33');
    });
  }finally{await new Promise(r=>server.close(r));await pool.end()}
});
