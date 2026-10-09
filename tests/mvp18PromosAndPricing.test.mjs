import test from 'node:test';
import assert from 'node:assert/strict';
import {lockValidPromo,consumePromo,discountForAmount} from '../src/services/promoCodes.js';
import * as promos from '../src/services/promoCodes.js';

test('promo reservation rejects a payment owned by another tenant before quota changes',async()=>{
 const client={query:async(sql)=>({rows:sql.includes('SELECT organization_id')?[{organization_id:'org-a'}]:[]})};
 await assert.rejects(()=>promos.reservePromo(client,{paymentId:'p',organizationId:'org-b'}),{code:'PAYMENT_NOT_FOUND'});
});

test('promo reservation quota includes active pending payments for global and tenant limits',async()=>{
 const promo={id:'promo',active:true,plan:'MONTHLY',max_uses:2,max_uses_per_org:1,used_count:0};
 const client={query:async(sql)=>{
  if(sql.includes('FROM platform_promos'))return {rows:[promo]};
  if(sql.includes('count(*)'))return {rows:[{n:1}]};
  return {rows:[]};
 }};
 await assert.rejects(()=>lockValidPromo(client,{code:'PROMO',plan:'MONTHLY',organizationId:'org'}),{code:'PROMO_ORG_LIMIT'});
 promo.max_uses=1;
 await assert.rejects(()=>lockValidPromo(client,{code:'PROMO',plan:'MONTHLY',organizationId:'org'}),{code:'PROMO_EXHAUSTED'});
});

const reservationClient=({draftChanges={},paymentChanges={},promoChanges={},insertError}={})=>{
 const payment={id:'payment',organization_id:'org',status:'REVIEW',type:'LICENSE',plan:'MONTHLY',amount:'175000',draft_id:'draft',...paymentChanges};
 const draft={id:'draft',organization_id:'org',status:'open',expires_at:'2099-01-01',type:'LICENSE',plan:'MONTHLY',base_amount:'350000',extra_store_amount:'0',total_amount:'175000',metadata:{promoId:'promo',promoCode:'PROMO',promoDiscount:175000,promoDiscountPercent:50},...draftChanges};
 const promo={id:'promo',active:true,plan:'MONTHLY',discount_percent:50,max_uses:10,max_uses_per_org:1,used_count:0,...promoChanges};
 return {query:async(sql,params)=>{
  if(sql.includes('SELECT organization_id'))return {rows:[{organization_id:'org'}]};
  if(sql.includes('FROM organizations'))return {rows:[{id:'org'}]};
  if(sql.includes('FROM billing_payments'))return {rows:[payment]};
  if(sql.includes('FROM billing_drafts'))return {rows:[draft]};
  if(sql.includes('FROM platform_promos'))return {rows:[promo]};
  if(sql.includes('count(*)'))return {rows:[{n:0}]};
  if(sql.includes('INSERT INTO platform_promo_reservations')){
   if(insertError)throw insertError;
   return {rows:[{promo_id:params[0],organization_id:params[1],payment_id:params[2],status:'RESERVED'}]};
  }
  if(sql.includes('FROM platform_promo_reservations'))return {rows:[]};
  throw new Error(`Unexpected SQL ${sql}`);
 }};
};

test('promo reservation validates draft amount, date, payment type and plan before capacity changes',async()=>{
 for(const [changes,code] of [
  [{draftChanges:{total_amount:175001}},'PROMO_QUOTE_STALE'],
  [{draftChanges:{expires_at:'2020-01-01'}},'PROMO_QUOTE_STALE'],
  [{paymentChanges:{type:'EXTRA'}},'PROMO_LICENSE_ONLY'],
  [{promoChanges:{plan:'ANNUAL'}},'PROMO_PLAN_MISMATCH'],
  [{promoChanges:{active:false}},'PROMO_INACTIVE'],
  [{promoChanges:{expires_at:'2020-01-01'}},'PROMO_INACTIVE'],
 ])await assert.rejects(()=>promos.reservePromo(reservationClient(changes),{paymentId:'payment',organizationId:'org'}),{code});
});

test('promo reservation translates only its known named unique and tenant constraints',async()=>{
 for(const [constraint,code] of [
  ['platform_promo_reservations_payment_unique','PROMO_RESERVATION_CONFLICT'],
  ['platform_promo_reservations_payment_tenant_fk','PROMO_TENANT_MISMATCH'],
 ])await assert.rejects(()=>promos.reservePromo(reservationClient({insertError:{constraint,code:constraint.endsWith('unique')?'23505':'23503'}}),{paymentId:'payment',organizationId:'org'}),{code});
 const unknown=Object.assign(new Error('unknown constraint'),{constraint:'unrelated_unique',code:'23505'});
 await assert.rejects(()=>promos.reservePromo(reservationClient({insertError:unknown}),{paymentId:'payment',organizationId:'org'}),error=>error===unknown);
});
test('promo quota and per-business quota are validated before consumption',async()=>{
 const promo={id:'promo-test',code:'ZENIX-50',active:true,plan:'MONTHLY',discount_percent:50,max_uses:5,max_uses_per_org:1,used_count:3};
 const queries=[];
 const db={query:async(sql,args)=>{queries.push(sql);if(sql.includes('FROM platform_promos'))return {rows:[promo]};if(sql.includes('count(*)'))return {rows:[{n:0}]};return {rowCount:1,rows:[]}}};
 const result=await lockValidPromo(db,{code:'  zenix-50  ',plan:'MONTHLY',organizationId:'org'});
 assert.equal(result.id,'promo-test');assert.equal(discountForAmount(350000,50),175000);
 await consumePromo(db,{promo,organizationId:'org',plan:'MONTHLY',discountAmount:175000});
 assert.ok(queries.some(x=>x.includes('used_count=used_count+1')));
 promo.used_count=5;
 await assert.rejects(()=>lockValidPromo(db,{code:'ZENIX-50',plan:'MONTHLY',organizationId:'org'}),{code:'PROMO_EXHAUSTED'});
});

test('a free promo activation clears only billing hold, not the platform suspension gate',async()=>{
 const fs=await import('node:fs');const source=fs.readFileSync(new URL('../src/routes/billing.js',import.meta.url),'utf8');
 assert.match(source,/org\.license_status==="SUSPENDED"/);
 assert.match(source,/PROMO_FREE_FLOW/);
 assert.match(source,/UPDATE organizations SET license_status='ACTIVE',plan=\$2,expiry_date=\$3,settings=jsonb_set/);
 assert.match(source,/await consumePromo\(client/);
});
