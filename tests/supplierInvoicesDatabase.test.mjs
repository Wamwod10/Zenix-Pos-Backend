import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {runTransaction} from '../src/db/tx.js';
import {createSupplierInvoice} from '../src/services/supplierInvoices.js';

const url=process.env.TEST_DATABASE_URL;
(url?test:test.skip)('supplier invoice replay is atomic, scoped and requires stable references',async t=>{
  assertSafeTestDatabaseUrl(url,{nodeEnv:process.env.NODE_ENV});
  const db=new pg.Pool({connectionString:url,max:3,options:'-c lock_timeout=5s -c statement_timeout=15s'});
  try{
    const token=randomUUID();
    const org=(await db.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES($1,'ACTIVE',CURRENT_DATE+30) RETURNING id",[`supplier-replay-${token}`])).rows[0].id;
    const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Invoice store') RETURNING id",[org])).rows[0].id;
    const actor=(await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Owner',$2,'unused','OWNER') RETURNING id",[org,`supplier-${token}`])).rows[0].id;
    const user={id:actor,organizationId:org,appRole:'OWNER'};
    const supplier=async()=>(await db.query("INSERT INTO suppliers(organization_id,name) VALUES($1,$2) RETURNING id",[org,`Supplier ${randomUUID()}`])).rows[0].id;
    const input=(changes={})=>({clientReference:randomUUID(),invoiceNo:'invoice',total:0.3,paidAmount:0.1,paymentMethod:'cash',dueDate:null,...changes});
    const create=(supplierId,payment,overrides={})=>runTransaction(db,c=>createSupplierInvoice(c,{user,supplierId,input:payment,storeId:store,...overrides}));
    const counts=async supplierId=>(await db.query(`SELECT (SELECT count(*) FROM supplier_invoices WHERE supplier_id=$1) invoices,
      (SELECT count(*) FROM supplier_payments WHERE supplier_id=$1) payments,
      (SELECT count(*) FROM audit_logs a JOIN supplier_invoices i ON a.entity_id=i.id::text WHERE i.supplier_id=$1 AND a.entity_type='supplier_invoice') audits,
      (SELECT count(*) FROM notification_outbox n JOIN supplier_invoices i ON n.event_id=i.id::text WHERE i.supplier_id=$1 AND n.event_type='supplier.debt') notifications`,[supplierId])).rows[0];
    await t.test('parallel retry commits one invoice, initial settlement, audit, notification and replay',async()=>{
      const id=await supplier(),payment=input();
      const results=await Promise.all([create(id,payment),create(id,payment)]);
      assert.equal(results[0].id,results[1].id);
      assert.deepEqual(await counts(id),{invoices:'1',payments:'1',audits:'1',notifications:'1'});
      const payload=(await db.query('SELECT payload FROM notification_outbox WHERE organization_id=$1 AND event_id=$2',[org,results[0].id])).rows[0].payload;
      assert.equal(payload.debt,0.2);
      assert.equal((await db.query("SELECT count(*) FROM financial_write_replays WHERE organization_id=$1 AND operation='supplier_invoice_create' AND client_reference=$2",[org,payment.clientReference])).rows[0].count,'1');
      await db.query('UPDATE suppliers SET archived=true WHERE id=$1',[id]);
      assert.equal((await create(id,payment)).id,results[0].id);
      await assert.rejects(create(id,input()),e=>e.status===404);
    });
    await t.test('same reference binds supplier, actor, store and complete invoice intent',async()=>{
      const id=await supplier(),other=await supplier(),payment=input();
      await create(id,payment);
      for(const change of [{total:0.4},{paidAmount:0.2},{invoiceNo:'changed'},{paymentMethod:'card'},{dueDate:'2027-01-01'}])await assert.rejects(create(id,{...payment,...change}),e=>e.code==='IDEMPOTENCY_CONFLICT');
      await assert.rejects(create(other,payment),e=>e.code==='IDEMPOTENCY_CONFLICT');
      await assert.rejects(create(id,payment,{storeId:null}),e=>e.code==='IDEMPOTENCY_CONFLICT');
      await assert.rejects(create(id,payment,{user:{...user,id:randomUUID()}}),e=>e.code==='IDEMPOTENCY_CONFLICT');
      assert.deepEqual(await counts(other),{invoices:'0',payments:'0',audits:'0',notifications:'0'});
    });
    await t.test('failure after initial settlement and audit rolls back entire operation and permits retry',async()=>{
      const id=await supplier(),payment=input();
      await assert.rejects(runTransaction(db,async c=>{
        const proxy={query:async(sql,values)=>{if(sql.includes('INSERT INTO notification_outbox'))throw new Error('injected invoice failure');return c.query(sql,values);}};
        await createSupplierInvoice(proxy,{user,supplierId:id,input:payment,storeId:store});
      }),/injected invoice failure/);
      assert.deepEqual(await counts(id),{invoices:'0',payments:'0',audits:'0',notifications:'0'});
      assert.equal((await db.query('SELECT count(*) FROM financial_write_replays WHERE organization_id=$1 AND client_reference=$2',[org,payment.clientReference])).rows[0].count,'0');
      await create(id,payment);assert.equal((await counts(id)).invoices,'1');
    });
    await t.test('missing invoice reference rejects without writes and initial settlement never debits register cash',async()=>{
      const id=await supplier(),payment=input({clientReference:''});
      for(const clientReference of ['', '   ', undefined])await assert.rejects(create(id,{...payment,clientReference}),e=>e.status===400&&e.code==='CLIENT_REFERENCE_REQUIRED');
      assert.deepEqual(await counts(id),{invoices:'0',payments:'0',audits:'0',notifications:'0'});
      await create(id,input());
      assert.equal((await db.query('SELECT count(*) FROM shift_movements WHERE organization_id=$1',[org])).rows[0].count,'0');
      assert.equal((await db.query('SELECT count(*) FROM supplier_payments WHERE supplier_id=$1 AND shift_id IS NOT NULL',[id])).rows[0].count,'0');
    });
  }finally{await db.end();}
});
