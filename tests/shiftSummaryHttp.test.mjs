import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {assertSafeTestDatabaseUrl} from '../scripts/assertTestDatabase.js';
const url=process.env.TEST_DATABASE_URL;
test('SHIFT01 HTTP summary scope and locked close cash precondition',{skip:!url,timeout:30000},async()=>{
  assertSafeTestDatabaseUrl(url);assert.equal(process.env.DATABASE_URL,url);
  const [{app},{pool},{env}]=await Promise.all([import('../src/app.js'),import('../src/db/pool.js'),import('../src/config/env.js')]);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,{cookie,method='GET',body}={})=>{
    const response=await fetch(base+path,{method,headers:{origin:'http://localhost:5173','x-zenix-client':'web','content-type':'application/json',cookie:cookie||''},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    return {status:response.status,body:await response.json()};
  };
  let writer;
  try{
    const org=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date,store_limit) VALUES('SHIFT01 HTTP','ACTIVE','2099-01-01',2) RETURNING id")).rows[0].id;
    const otherOrg=(await pool.query("INSERT INTO organizations(name,license_status,expiry_date) VALUES('SHIFT01 foreign HTTP','ACTIVE','2099-01-01') RETURNING id")).rows[0].id;
    const stores=[];for(const name of ['A','B'])stores.push((await pool.query('INSERT INTO stores(organization_id,name) VALUES($1,$2) RETURNING id',[org,name])).rows[0].id);
    const account=async(role,organizationId=org,storeId=stores[0],overrides={})=>{
      const user=(await pool.query("INSERT INTO users(organization_id,store_id,name,username,password_hash,app_role,permission_overrides) VALUES($1,$2,'SHIFT01 HTTP',$3,'test-only',$4,$5) RETURNING id",[organizationId,storeId,randomUUID(),role,overrides])).rows[0].id;
      const token=randomUUID();await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[user,createHash('sha256').update(token).digest('hex')]);
      return {id:user,cookie:`${env.sessionCookieName}=${token}`};
    };
    const owner=await account('OWNER'),cashier=await account('CASHIER'),otherBranch=await account('CASHIER',org,stores[1]),denied=await account('CASHIER',org,stores[0],{moduleShifts:false}),foreign=await account('OWNER',otherOrg,null);
    const shift=(await pool.query('INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,opening_cash) VALUES($1,$2,$3,$4,100.10) RETURNING id',[org,stores[0],cashier.id,randomUUID()])).rows[0].id;
    const path=`/api/shifts/${shift}`;
    // Blank/null cash and fractional tiyin must never be silently treated
    // as 0 or rounded by NUMERIC(18,2), especially at shift close.
    for(const invalid of ['',null,'0.001',0.001,'-1','9000000000001']){
      const opening=await request('/api/shifts/open',{cookie:cashier.cookie,method:'POST',body:{storeId:stores[0],openingCash:invalid}});
      assert.equal(opening.status,400,'invalid openingCash '+String(invalid));
      const movement=await request(path+'/movements',{cookie:cashier.cookie,method:'POST',body:{type:'in',amount:invalid,reason:'QA invalid money'}});
      assert.equal(movement.status,400,'invalid movement '+String(invalid));
      const close=await request(path+'/close',{cookie:owner.cookie,method:'POST',body:{actualCash:invalid}});
      assert.equal(close.status,400,'invalid actualCash '+String(invalid));
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM shift_movements WHERE shift_id=$1",[shift])).rows[0].n,0);
    assert.equal((await pool.query("SELECT status FROM shifts WHERE id=$1",[shift])).rows[0].status,'open');
    assert.equal((await request(path+'/summary',{cookie:cashier.cookie})).body.data.summary.expectedCash,100.1);
    assert.equal((await request(path+'/summary',{cookie:otherBranch.cookie})).status,403);
    assert.equal((await request(path+'/summary',{cookie:denied.cookie})).status,403);
    assert.equal((await request(path+'/summary',{cookie:foreign.cookie})).status,404);
    const summary=await request(path+'/summary',{cookie:owner.cookie});assert.equal(summary.status,200);
    for(const expectedCash of [0.001,Number.MAX_SAFE_INTEGER])assert.equal((await request(path+'/close',{cookie:owner.cookie,method:'POST',body:{actualCash:100.10,expectedCash}})).status,400);
    await pool.query("INSERT INTO expenses(organization_id,store_id,title,amount,payment_method) VALUES($1,$2,'Private expense fixture',41.25,'card')",[org,stores[0]]);
    const history=await request(`/api/finance?storeId=${stores[0]}`,{cookie:cashier.cookie});
    assert.equal(history.status,200);assert.equal(Object.hasOwn(history.body.data,'expenses'),false);
    assert.equal(Object.hasOwn(history.body.data.aggregate,'expenseTotal'),false);
    assert.equal(Object.hasOwn(history.body.data.aggregate,'netProfit'),false);
    assert.equal(Object.hasOwn(history.body.data.pagination,'expenseTotal'),false);
    const analyst=await account('CASHIER',org,stores[0],{analytics:true});
    const aggregate=await request(`/api/finance?storeId=${stores[0]}`,{cookie:analyst.cookie});
    assert.equal(aggregate.status,200);assert.equal(aggregate.body.data.aggregate.expenseTotal,41.25);
    assert.equal(aggregate.body.data.aggregate.netProfit,-41.25);assert.equal(Object.hasOwn(aggregate.body.data,'expenses'),false);
    for(const authorized of [owner,await account('ADMIN'),await account('MANAGER')]){
      const full=await request(`/api/finance?storeId=${stores[0]}`,{cookie:authorized.cookie});
      assert.equal(full.status,200);assert.equal(full.body.data.expenses[0].title,'Private expense fixture');
      assert.equal(full.body.data.aggregate.expenseTotal,41.25);assert.equal(full.body.data.pagination.expenseTotal,1);
    }
    writer=await pool.connect();await writer.query('BEGIN');await writer.query('SELECT id FROM shifts WHERE id=$1 FOR UPDATE',[shift]);
    await writer.query("INSERT INTO shift_movements(organization_id,shift_id,type,amount,source) VALUES($1,$2,'in',25.25,'manual')",[org,shift]);
    let settled=false;
    const pending=request(path+'/close',{cookie:owner.cookie,method:'POST',body:{actualCash:100.10,expectedCash:summary.body.data.summary.expectedCash}}).then(result=>{settled=true;return result});
    // Prove the HTTP close waits for this fixture's cash transaction to commit.
    for(let attempt=0;attempt<50;attempt++){
      const waiting=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1",[writer.processID])).rows.length;
      if(waiting)break;
      assert.equal(settled,false);await new Promise(r=>setTimeout(r,10));
      if(attempt===49)assert.fail('HTTP close never waited on the shift lock');
    }
    await writer.query('COMMIT');writer.release();writer=null;
    const conflict=await pending;assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'SHIFT_CASH_CHANGED');
    assert.equal((await pool.query('SELECT status FROM shifts WHERE id=$1',[shift])).rows[0].status,'open');
    const refreshed=await request(path+'/summary',{cookie:owner.cookie});assert.equal(refreshed.body.data.summary.expectedCash,125.35);
    const closed=await request(path+'/close',{cookie:owner.cookie,method:'POST',body:{actualCash:125.35,expectedCash:125.35}});
    assert.equal(closed.status,200,JSON.stringify(closed.body));assert.equal(Number(closed.body.data.shift.difference),0);
    const legacyShift=(await pool.query('INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,opening_cash) VALUES($1,$2,$3,$4,0.10) RETURNING id',[org,stores[0],cashier.id,randomUUID()])).rows[0].id;
    const legacy=await request(`/api/shifts/${legacyShift}/close`,{cookie:owner.cookie,method:'POST',body:{actualCash:0.10}});
    assert.equal(legacy.status,200,'older clients may omit the new cash precondition');
    assert.equal(Number(legacy.body.data.shift.difference),0);
  }finally{
    if(writer){await writer.query('ROLLBACK');writer.release()}
    await new Promise(r=>server.close(r));await pool.end();
  }
});
