import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {runTransaction} from '../src/db/tx.js';
import {recordCustomerRepayment} from '../src/services/customerRepayments.js';

const url=process.env.TEST_DATABASE_URL;
const integration=url?test:test.skip;
integration('customer repayment cash provenance, concurrency, rollback and authorization', {timeout:30000},async t=>{
  assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
  const db=new pg.Pool({connectionString:url,max:4,options:'-c lock_timeout=5s -c statement_timeout=15s'});
  const token=randomUUID();
  try{
    const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES($1,'ACTIVE',CURRENT_DATE+30,3) RETURNING id",[`repayment-${token}`])).rows[0].id;
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Cash store') RETURNING id",[org])).rows[0].id;
    const otherStore=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Other store') RETURNING id",[org])).rows[0].id;
    const actor=(await db.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role) VALUES($1,$2,'Owner',$3,'unused','OWNER') RETURNING id",[org,store,`repay-${token}`])).rows[0].id;
    const user={id:actor,organizationId:org,appRole:'OWNER',storeId:store};
    const shift=(await db.query("INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,opening_cash) VALUES($1,$2,$3,$4,0) RETURNING *",[org,store,actor,`store:${store}`])).rows[0];
    async function customer(debt=100){
      const id=(await db.query("INSERT INTO customers(organization_id,name) VALUES($1,$2) RETURNING id",[org,`Customer ${randomUUID()}`])).rows[0].id;
      await db.query("INSERT INTO customer_ledger(organization_id,customer_id,store_id,entry_type,amount) VALUES($1,$2,$3,'CREDIT_SALE',$4)",[org,id,store,debt]);
      return id;
    }
    const input=(changes={})=>({clientReference:randomUUID(),amount:30,paymentMethod:'cash',note:'',shiftId:shift.id,...changes});
    const pay=(customerId,payment,overrides={})=>runTransaction(db,c=>recordCustomerRepayment(c,{user,customerId,input:payment,storeId:store,...overrides}));
    const counts=async id=>(await db.query(`SELECT (SELECT count(*) FROM customer_ledger WHERE customer_id=$1 AND entry_type='PAYMENT') payments,
      (SELECT count(*) FROM customer_payment_allocations WHERE customer_id=$1) allocations,
      (SELECT count(*) FROM shift_movements m JOIN customer_ledger l ON l.id=m.customer_payment_ledger_id WHERE l.customer_id=$1) movements`,[id])).rows[0];
    await t.test('parallel same reference creates one ledger, allocation, cash movement and replay after closure',async()=>{
      const id=await customer(),payment=input();
      const results=await Promise.all([pay(id,payment),pay(id,payment)]);
      assert.equal(results[0].id,results[1].id);
      assert.deepEqual(await counts(id),{payments:'1',allocations:'1',movements:'1'});
      const row=(await db.query('SELECT * FROM shift_movements WHERE customer_payment_ledger_id=$1',[results[0].id])).rows[0];
      assert.equal(row.shift_id,shift.id);assert.equal(row.amount,'30.00');assert.equal(row.type,'in');
      assert.equal(results[0].register_id,shift.register_id);assert.equal(results[0].shift_id,shift.id);
      await db.query("UPDATE shifts SET status='closed' WHERE id=$1",[shift.id]);
      assert.equal((await pay(id,payment)).id,results[0].id);
      await assert.rejects(pay(id,{...payment,amount:31}),e=>e.code==='IDEMPOTENCY_CONFLICT');
      await assert.rejects(pay(id,input()),e=>e.code==='SHIFT_REQUIRED');
      await db.query("UPDATE shifts SET status='open' WHERE id=$1",[shift.id]);
    });
    await t.test('different references serialize customer balance and reject overpayment',async()=>{
      const id=await customer(50);
      const outcomes=await Promise.allSettled([pay(id,input()),pay(id,input())]);
      assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'CUSTOMER_PAYMENT_EXCEEDS_BALANCE');
      assert.deepEqual(await counts(id),{payments:'1',allocations:'1',movements:'1'});
    });
    await t.test('failure after cash movement rolls back ledger, allocations, movement and audit',async()=>{
      const id=await customer(),payment=input();
      await assert.rejects(runTransaction(db,async c=>{
        const proxy={query:async(sql,values)=>{if(sql.includes('INSERT INTO customer_payment_allocations'))throw new Error('injected failure after ledger');return c.query(sql,values);}};
        await recordCustomerRepayment(proxy,{user,customerId:id,input:payment,storeId:store});
      }),/injected failure after ledger/);
      assert.deepEqual(await counts(id),{payments:'0',allocations:'0',movements:'0'});
      await assert.rejects(runTransaction(db,async c=>{
        const proxy={query:async(sql,values)=>{if(sql.includes('INSERT INTO audit_logs'))throw new Error('injected failure after movement');return c.query(sql,values);}};
        await recordCustomerRepayment(proxy,{user,customerId:id,input:payment,storeId:store});
      }),/injected failure/);
      assert.deepEqual(await counts(id),{payments:'0',allocations:'0',movements:'0'});
      await pay(id,payment);assert.deepEqual(await counts(id),{payments:'1',allocations:'1',movements:'1'});
    });
    await t.test('wrong store, foreign tenant, permissions and cashier ownership reject without writes',async()=>{
      const id=await customer();
      await assert.rejects(pay(id,input(),{storeId:otherStore}),e=>e.code==='SHIFT_REQUIRED');
      const foreign=(await db.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES($1,'ACTIVE',CURRENT_DATE+30) RETURNING id",[`foreign-${token}`])).rows[0].id;
      await assert.rejects(pay(id,input(),{user:{...user,organizationId:foreign}}),e=>['SHIFT_REQUIRED','STORE_INACTIVE'].includes(e.code));
      await assert.rejects(pay(id,input(),{user:{...user,appRole:'CASHIER',permissionOverrides:{moduleShifts:false}}}),e=>e.code==='FORBIDDEN');
      await assert.rejects(pay(id,input(),{user:{...user,id:randomUUID(),appRole:'CASHIER'}}),e=>e.code==='SHIFT_FORBIDDEN');
      assert.deepEqual(await counts(id),{payments:'0',allocations:'0',movements:'0'});
    });
    await t.test('register identity mismatch rejects and noncash never adds register cash',async()=>{
      const id=await customer();
      // Inactivation of an open register is itself rejected by the database guard.
      await assert.rejects(db.query('UPDATE pos_registers SET active=false WHERE id=$1',[shift.register_id]),e=>e.code==='ZX423');
      for(const method of ['card','transfer'])await pay(id,input({paymentMethod:method,shiftId:undefined}));
      assert.deepEqual(await counts(id),{payments:'2',allocations:'2',movements:'0'});
    });
    await t.test('database prevents duplicate repayment references and movement links',async()=>{
      const id=await customer(),payment=await pay(id,input());
      await assert.rejects(db.query(`INSERT INTO customer_ledger(organization_id,customer_id,entry_type,amount,repayment_client_reference)
        VALUES($1,$2,'PAYMENT',-1,$3)`,[org,id,payment.repayment_client_reference]),e=>e.code==='23505');
      await assert.rejects(db.query(`INSERT INTO shift_movements(organization_id,shift_id,type,amount,source,reference_id,customer_payment_ledger_id)
        VALUES($1,$2,'in',30,'customer_payment',($3::uuid)::text,$3::uuid)`,[org,shift.id,payment.id]),e=>e.code==='23505');
    });
    await t.test('deferred constraints reject missing, mismatched, deleted or detached cash movement',async()=>{
      const id=await customer(),request=input(),payment=await pay(id,request);
      const secondShift=(await db.query("INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,opening_cash) VALUES($1,$2,$3,$4,0) RETURNING id",[org,otherStore,actor,`store:${otherStore}`])).rows[0].id;
      for(const [sql,values] of [
        ['UPDATE shift_movements SET amount=amount+1 WHERE customer_payment_ledger_id=$1',[payment.id]],
        ['UPDATE shift_movements SET shift_id=$2 WHERE customer_payment_ledger_id=$1',[payment.id,secondShift]],
        ['DELETE FROM shift_movements WHERE customer_payment_ledger_id=$1',[payment.id]],
        ['UPDATE shift_movements SET customer_payment_ledger_id=NULL WHERE customer_payment_ledger_id=$1',[payment.id]],
        ['UPDATE customer_ledger SET amount=amount-1 WHERE id=$1',[payment.id]],
        ['UPDATE customer_ledger SET store_id=$2 WHERE id=$1',[payment.id,otherStore]],
        ['UPDATE customer_ledger SET shift_id=NULL,register_id=NULL WHERE id=$1',[payment.id]],
      ])await assert.rejects(runTransaction(db,c=>c.query(sql,values)),e=>['23514','23503'].includes(e.code));
      await assert.rejects(runTransaction(db,c=>c.query(`INSERT INTO customer_ledger(organization_id,customer_id,store_id,entry_type,amount,payment_method,shift_id,register_id,repayment_client_reference)
        VALUES($1,$2,$3,'PAYMENT',-1,'cash',$4,$5,$6)`,[org,id,store,shift.id,shift.register_id,randomUUID()])),e=>e.code==='23514');
      assert.deepEqual(await counts(id),{payments:'1',allocations:'1',movements:'1'});
      assert.equal((await pay(id,request)).id,payment.id);
      // Deferred checks permit a temporary mismatch if the pair agrees at commit.
      await runTransaction(db,async c=>{
        await c.query('UPDATE customer_ledger SET amount=amount-1 WHERE id=$1',[payment.id]);
        await c.query('UPDATE shift_movements SET amount=amount+1 WHERE customer_payment_ledger_id=$1',[payment.id]);
        await c.query('UPDATE customer_ledger SET amount=amount+1 WHERE id=$1',[payment.id]);
        await c.query('UPDATE shift_movements SET amount=amount-1 WHERE customer_payment_ledger_id=$1',[payment.id]);
      });
      // A complete pair deletion leaves no invalid provenance and normal FKs still apply.
      await runTransaction(db,async c=>{
        await c.query('DELETE FROM customer_payment_allocations WHERE payment_ledger_id=$1',[payment.id]);
        await c.query('DELETE FROM shift_movements WHERE customer_payment_ledger_id=$1',[payment.id]);
        await c.query('DELETE FROM customer_ledger WHERE id=$1',[payment.id]);
      });
      assert.deepEqual(await counts(id),{payments:'0',allocations:'0',movements:'0'});
    });
  }finally{await db.end();}
});
