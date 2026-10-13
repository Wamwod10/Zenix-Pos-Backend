import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
import {SUBSCRIPTION_CATALOG} from '../src/config/subscriptions.js';
const url=process.env.RESOURCE_TEST_DATABASE_URL;
test('Start active employee limit excludes OWNER and guards direct backend SQL',{skip:!url},async()=>{
  assertSafeTestDatabaseUrl(url);const db=new pg.Pool({connectionString:url});
  try{
    const org=(await db.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Resource test','START','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
    const staff=role=>db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Test',$2,'test',$3) RETURNING id",[org,randomUUID(),role]);
    await staff('OWNER');await staff('ADMIN');await staff('MANAGER');
    await assert.rejects(()=>staff('ADMIN'),error=>error.code==='ZX409'&&JSON.parse(error.detail).resource==='employees'&&JSON.parse(error.detail).used===2);
  }finally{await db.end()}
});
test('all tiers: exact boundaries, parallel growth, history, downgrade and registered POS lifecycle',{skip:!url,timeout:120000},async t=>{
  assertSafeTestDatabaseUrl(url);const db=new pg.Pool({connectionString:url,max:12});
  const createOrg=async plan=>(await db.query("INSERT INTO organizations(name,plan_code,license_status,expiry_date) VALUES('Limits acceptance',$1,'ACTIVE','2099-01-01') RETURNING id",[plan])).rows[0].id;
  const rejected=resource=>error=>error.code==='ZX409'&&JSON.parse(error.detail).resource===resource;
  try{
    for(const plan of Object.values(SUBSCRIPTION_CATALOG[1]))await t.test(plan.code,async()=>{
      const org=await createOrg(plan.code);
      const staff=(active=true,role='ADMIN')=>db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role,active) VALUES($1,'Test',$2,'test',$3,$4) RETURNING id",[org,randomUUID(),role,active]);
      await staff(true,'OWNER');
      for(let i=0;i<plan.limits.employees;i++)await staff();
      await assert.rejects(()=>staff(),rejected('employees'));
      const inactive=(await staff(false)).rows[0].id;
      await assert.rejects(()=>db.query('UPDATE users SET active=true WHERE id=$1',[inactive]),rejected('employees'));
      await db.query("UPDATE users SET active=false WHERE id=(SELECT id FROM users WHERE organization_id=$1 AND app_role='ADMIN' AND active LIMIT 1)",[org]);
      await db.query('UPDATE users SET active=true WHERE id=$1',[inactive]);
      const stores=[];
      for(let i=0;i<plan.limits.stores;i++)stores.push((await db.query('INSERT INTO stores(organization_id,name) VALUES($1,$2) RETURNING id',[org,`Branch ${i}`])).rows[0].id);
      await assert.rejects(()=>db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Excess')",[org]),rejected('stores'));
      for(let i=stores.length;i<plan.limits.warehouses;i++)await db.query('INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,$3)',[org,stores[0],`Warehouse ${i}`]);
      await assert.rejects(()=>db.query("INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,'Excess')",[org,stores[0]]),rejected('warehouses'));
      const register=active=>db.query("INSERT INTO pos_registers(organization_id,store_id,name,register_key,active) VALUES($1,$2,'POS test',$3,$4) RETURNING id,register_key",[org,stores[0],randomUUID(),active]);
      for(let i=0;i<plan.limits.registers;i++)await register(true);
      await assert.rejects(()=>register(true),rejected('registers'));
      const spare=(await register(false)).rows[0];
      await assert.rejects(()=>db.query('UPDATE pos_registers SET active=true WHERE id=$1',[spare.id]),rejected('registers'));
      for(const [resource,table] of [['products','products'],['customers','customers']]){
        const cap=plan.limits[resource],count=cap??11000;
        await db.query(`INSERT INTO ${table}(organization_id,name) SELECT $1,'Resource '||n FROM generate_series(1,$2) n`,[org,count]);
        if(cap!==null)await assert.rejects(()=>db.query(`INSERT INTO ${table}(organization_id,name) VALUES($1,'Excess')`,[org]),rejected(resource));
        await db.query(`UPDATE ${table} SET archived=true WHERE id=(SELECT id FROM ${table} WHERE organization_id=$1 LIMIT 1)`,[org]);
        if(cap!==null)await assert.rejects(()=>db.query(`INSERT INTO ${table}(organization_id,name) VALUES($1,'Archived still counts')`,[org]),rejected(resource));
        await db.query(`UPDATE ${table} SET archived=false WHERE organization_id=$1 AND archived`,[org]);
      }
      const usage=(await db.query("SELECT resource_entitlement($1,'employees') AS state",[org])).rows[0].state;assert.equal(usage.used,plan.limits.employees);
      if(plan.code==='PREMIUM'){
        await db.query("UPDATE organizations SET plan_code='START' WHERE id=$1",[org]);
        const before=(await db.query("SELECT jsonb_object_agg(r,resource_entitlement($1,r)->'used') counts FROM unnest(ARRAY['employees','stores','warehouses','registers','products','customers']) r",[org])).rows[0].counts;
        await assert.rejects(()=>staff(),rejected('employees'));
        await assert.rejects(()=>db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Downgrade excess')",[org]),rejected('stores'));
        await assert.rejects(()=>db.query("INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,'Downgrade excess')",[org,stores[0]]),rejected('warehouses'));
        await assert.rejects(()=>register(true),rejected('registers'));
        for(const resource of ['products','customers'])await assert.rejects(()=>db.query(`INSERT INTO ${resource}(organization_id,name) VALUES($1,'Downgrade excess')`,[org]),rejected(resource));
        const after=(await db.query("SELECT jsonb_object_agg(r,resource_entitlement($1,r)->'used') counts FROM unnest(ARRAY['employees','stores','warehouses','registers','products','customers']) r",[org])).rows[0].counts;assert.deepEqual(after,before);
      }
    });
    await t.test('parallel final employee slot serializes and downgrade preserves existing records',async()=>{
      const org=await createOrg('START');
      const staff=()=>db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Test',$2,'test','ADMIN')",[org,randomUUID()]);
      await staff();const results=await Promise.allSettled(Array.from({length:10},staff));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(results.filter(r=>r.status==='rejected').every(r=>rejected('employees')(r.reason)));
      await db.query("UPDATE organizations SET plan_code='PREMIUM' WHERE id=$1",[org]);await staff();
      await db.query("UPDATE organizations SET plan_code='START' WHERE id=$1",[org]);
      assert.equal((await db.query("SELECT resource_entitlement($1,'employees') AS state",[org])).rows[0].state.overLimit,1);
      await assert.rejects(staff,rejected('employees'));await db.query("UPDATE users SET name='History intact' WHERE organization_id=$1",[org]);
    });
    await t.test('register tenant FK, shift binding, inactive protection and open shift deactivation',async()=>{
      const org=await createOrg('BUSINESS'),other=await createOrg('BUSINESS');
      const store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Main') RETURNING id",[org])).rows[0].id;
      const user=(await db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Owner',$2,'test','OWNER') RETURNING id",[org,randomUUID()])).rows[0].id;
      await assert.rejects(()=>db.query("INSERT INTO pos_registers(organization_id,store_id,name,register_key) VALUES($1,$2,'Foreign','foreign')",[other,store]),e=>e.code==='23503');
      const shift=(await db.query("INSERT INTO shifts(organization_id,store_id,cashier_id,register_key) VALUES($1,$2,$3,$4) RETURNING id,register_id",[org,store,user,`store:${store}`])).rows[0];assert.ok(shift.register_id);
      await assert.rejects(()=>db.query('UPDATE pos_registers SET active=false WHERE id=$1',[shift.register_id]),e=>e.code==='ZX423');
      await db.query("UPDATE shifts SET status='closed',closed_at=now() WHERE id=$1",[shift.id]);await db.query('UPDATE pos_registers SET active=false WHERE id=$1',[shift.register_id]);
      await assert.rejects(()=>db.query("INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,register_id) VALUES($1,$2,$3,$4,$5)",[org,store,user,`store:${store}`,shift.register_id]),e=>e.code==='ZX424');
      assert.equal((await db.query('SELECT count(*)::int count FROM shifts WHERE organization_id=$1',[org])).rows[0].count,1);
    });
    await t.test('every resource serializes concurrent requests for its final slot',async()=>{
      for(const resource of ['employees','stores','warehouses','registers','products','customers']){
        const org=await createOrg(resource==='warehouses'?'BUSINESS':'START');
        let store;
        if(['warehouses','registers'].includes(resource))store=(await db.query("INSERT INTO stores(organization_id,name) VALUES($1,'Main') RETURNING id",[org])).rows[0].id;
        let insert;
        if(resource==='employees'){
          insert=()=>db.query("INSERT INTO users(organization_id,name,username,password_hash,app_role) VALUES($1,'Test',$2,'test','ADMIN')",[org,randomUUID()]);await insert();
        }else if(resource==='stores')insert=()=>db.query('INSERT INTO stores(organization_id,name) VALUES($1,$2)',[org,randomUUID()]);
        else if(resource==='warehouses'){
          insert=()=>db.query('INSERT INTO warehouses(organization_id,store_id,name) VALUES($1,$2,$3)',[org,store,randomUUID()]);await insert();
        }else if(resource==='registers')insert=()=>db.query("INSERT INTO pos_registers(organization_id,store_id,name,register_key) VALUES($1,$2,'POS',$3)",[org,store,randomUUID()]);
        else{
          const cap=SUBSCRIPTION_CATALOG[1].START.limits[resource];
          await db.query(`INSERT INTO ${resource}(organization_id,name) SELECT $1,'Fixture '||n FROM generate_series(1,$2) n`,[org,cap-1]);
          insert=()=>db.query(`INSERT INTO ${resource}(organization_id,name) VALUES($1,'Parallel')`,[org]);
        }
        const results=await Promise.allSettled(Array.from({length:8},insert));assert.equal(results.filter(r=>r.status==='fulfilled').length,1,resource);assert.ok(results.filter(r=>r.status==='rejected').every(r=>rejected(resource)(r.reason)),resource);
      }
    });
  }finally{await db.end()}
});
