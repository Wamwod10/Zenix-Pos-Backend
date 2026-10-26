import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCustomerRepayment } from '../src/services/customerRepayments.js';
import { requestFingerprint } from '../src/services/posReplay.js';

const user={id:'actor',organizationId:'org',appRole:'OWNER'};
const base={user,customerId:'customer',storeId:null,input:{clientReference:'reference',amount:0.3,paymentMethod:'card',note:''}};
test('completed cash replay precedes closed shift and cash authorization checks',async()=>{
  const args={...base,storeId:'store',input:{...base.input,paymentMethod:'cash',shiftId:'closed-shift'}};
  const previous={id:'payment',customer_id:args.customerId,metadata:{fingerprint:requestFingerprint({customerId:args.customerId,userId:user.id,...args.input,storeId:args.storeId})}};
  const calls=[];
  const client={query:async sql=>{calls.push(sql);return {rows:sql.includes('FROM customer_ledger')?[previous]:[]};}};
  assert.equal(await recordCustomerRepayment(client,args),previous);
  assert.equal(calls.length,2);
  for(const change of [{shiftId:'other-shift'},{amount:0.2}]){
    await assert.rejects(recordCustomerRepayment(client,{...args,input:{...args.input,...change}}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  }
});
test('new cash requires a stable reference and explicit shift before any financial write',async()=>{
  const calls=[];
  const client={query:async sql=>{calls.push(sql);return {rows:[]};}};
  await assert.rejects(recordCustomerRepayment(client,{...base,input:{...base.input,paymentMethod:'cash',clientReference:''}}),e=>e.code==='CLIENT_REFERENCE_REQUIRED');
  assert.equal(calls.length,0);
  await assert.rejects(recordCustomerRepayment(client,{...base,input:{...base.input,paymentMethod:'cash'}}),e=>e.code==='SHIFT_REQUIRED');
  assert.ok(calls.every(sql=>!sql.includes('INSERT')));
});
test('all repayment methods require a nonblank reference before database access',async()=>{
  const client={query:async()=>{assert.fail('Missing reference must not access the database');}};
  for(const paymentMethod of ['cash','card','transfer'])for(const clientReference of ['', '   ', undefined]){
    await assert.rejects(recordCustomerRepayment(client,{...base,input:{...base.input,paymentMethod,clientReference}}),e=>e.status===400&&e.code==='CLIENT_REFERENCE_REQUIRED');
  }
});
test('noncash FIFO allocation uses exact cents and never adds register cash',async()=>{
  const writes=[];
  const client={query:async(sql,values)=>{
    if(sql.includes('INSERT'))writes.push({sql,values});
    if(sql.includes('FROM customers'))return {rows:[{id:'customer',name:'Customer'}]};
    if(sql.includes('sum(amount),0) balance'))return {rows:[{balance:'0.30'}]};
    if(sql.includes('INSERT INTO customer_ledger'))return {rows:[{id:'payment'}]};
    if(sql.includes('SELECT cl.id'))return {rows:[{id:'credit1',open_amount:'0.10'},{id:'credit2',open_amount:'0.20'}]};
    return {rows:[]};
  }};
  await recordCustomerRepayment(client,base);
  assert.deepEqual(writes.filter(x=>x.sql.includes('customer_payment_allocations')).map(x=>x.values[4]),[0.1,0.2]);
  assert.equal(writes.some(x=>x.sql.includes('shift_movements')),false);
  const ledger=writes.find(x=>x.sql.includes('INSERT INTO customer_ledger'));
  assert.equal(ledger.values[8],null);
  assert.equal(ledger.values[9],null);
});
test('insufficient debt rejects before ledger, allocation or movement writes',async()=>{
  const client={query:async sql=>{
    assert.ok(!sql.includes('INSERT'));
    if(sql.includes('FROM customers'))return {rows:[{id:'customer'}]};
    if(sql.includes('sum(amount),0) balance'))return {rows:[{balance:'0.20'}]};
    return {rows:[]};
  }};
  await assert.rejects(recordCustomerRepayment(client,base),e=>e.code==='CUSTOMER_PAYMENT_EXCEEDS_BALANCE');
});
test('cash locks organization then shift then customer and binds one incoming movement',async()=>{
  const calls=[];
  const client={query:async(sql,values)=>{
    calls.push({sql,values});
    if(sql.includes('FROM organizations'))return {rows:[{id:'org',settings:{},license_status:'ACTIVE',store_limit:1,timezone:'UTC'}]};
    if(sql.includes('FROM shifts'))return {rows:[{id:'shift',organization_id:'org',store_id:'store',cashier_id:'actor',status:'open',register_id:'register',register_key:'key'}]};
    if(sql.includes('FROM pos_registers'))return {rows:[{id:'register',active:true,register_key:'key'}]};
    if(sql.includes('FROM stores'))return {rows:[{id:'store',active:true}]};
    if(sql.includes('FROM customers'))return {rows:[{id:'customer',name:'Customer'}]};
    if(sql.includes('sum(amount),0) balance'))return {rows:[{balance:'0.30'}]};
    if(sql.includes('INSERT INTO customer_ledger'))return {rows:[{id:'payment'}]};
    return {rows:[]};
  }};
  await recordCustomerRepayment(client,{...base,storeId:'store',input:{...base.input,paymentMethod:'cash',shiftId:'shift'}});
  const org=calls.findIndex(x=>x.sql.includes('FROM organizations'));
  const shift=calls.findIndex(x=>x.sql.includes('FROM shifts'));
  const customer=calls.findIndex(x=>x.sql.includes('FROM customers'));
  assert.ok(org<shift&&shift<customer);
  const ledger=calls.find(x=>x.sql.includes('INSERT INTO customer_ledger'));
  assert.deepEqual(ledger.values.slice(8),['shift','register','reference']);
  const movements=calls.filter(x=>x.sql.includes('INSERT INTO shift_movements'));
  assert.equal(movements.length,1);
  assert.deepEqual(movements[0].values,['org','shift',0.3,'Customer debt repayment','payment','actor']);
});
