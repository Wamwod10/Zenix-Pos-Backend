import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';

test('PostgreSQL: free payment, redemption, trial conversion and one-use reset are atomic', {skip:!process.env.TEST_DATABASE_URL?'Explicit isolated TEST_DATABASE_URL is required':false},async()=>{
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const client=await db.connect();
  try{
    // Require an already-migrated test database. Never reset or migrate production.
    const {assertDatabaseReady}=await import('../src/db/readiness.js');
    await assertDatabaseReady(db);
    const [{activateFreePromo},{issuePasswordReset,consumePasswordReset}]=await Promise.all([import('../src/routes/billing.js'),import('../src/services/passwordReset.js')]);
    await client.query('BEGIN');
    const org=(await client.query("INSERT INTO organizations(name,license_status,expiry_date,settings) VALUES('Disposable SaaS test','ACTIVE',CURRENT_DATE+14,$1) RETURNING *",[{trialUsed:true,trialEndsAt:new Date(Date.now()+14*86400000).toISOString(),billingHold:true}])).rows[0];
    const user=(await client.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Test Owner',$2,'unused-test-hash','OWNER') RETURNING *",[org.id,`saas_${randomUUID()}`])).rows[0];
    const code=`TEST-${randomUUID().slice(0,12).toUpperCase()}`;
    await client.query("INSERT INTO platform_promos(code,discount_percent,max_uses,max_uses_per_org) VALUES($1,100,1,1)",[code]);
    const input={code,plan:'MONTHLY',requestId:randomUUID()},actor={id:user.id,organizationId:org.id};
    const first=await activateFreePromo(client,actor,input);
    assert.deepEqual(await activateFreePromo(client,actor,input),first);
    const payment=(await client.query('SELECT * FROM billing_payments WHERE id=$1',[first.paymentId])).rows[0];
    assert.equal(Number(payment.amount),0);assert.equal(payment.status,'APPROVED');assert.equal(payment.receipt_id,null);
    const promo=(await client.query('SELECT used_count FROM platform_promos WHERE code=$1',[code])).rows[0];
    assert.equal(promo.used_count,1);
    const converted=(await client.query('SELECT * FROM organizations WHERE id=$1',[org.id])).rows[0];
    assert.equal(converted.settings.trialEndsAt,undefined);assert.equal(converted.settings.trialUsed,true);assert.equal(converted.settings.billingHold,false);
    const reset=await issuePasswordReset(client,{organizationId:org.id,userId:user.id,actorId:user.id,reason:'Disposable test identity verified',identityVerified:true});
    await consumePasswordReset(client,{token:reset.token,passwordHash:'new-test-hash'});
    await assert.rejects(()=>consumePasswordReset(client,{token:reset.token,passwordHash:'another-hash'}),{code:'RESET_TOKEN_INVALID'});
    assert.equal((await client.query('SELECT password_hash FROM users WHERE id=$1',[user.id])).rows[0].password_hash,'new-test-hash');
  }finally{await client.query('ROLLBACK');client.release();await db.end()}
});
