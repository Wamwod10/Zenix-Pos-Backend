import test from 'node:test';import assert from 'node:assert/strict';
import {readCustomerRedemptionQuote,readRedemptionPolicy} from '../src/services/loyaltyRedemptionPolicy.js';
import {debitSaleRedemption} from '../src/services/loyaltyRedemptionLedger.js';
const org='o',customer='c',sale='s',actor='a';
const settings={workspaceSettings:{loyalty:{redemption:{enabled:true,valuePerPoint:100,maxShareBps:5000}}}};
test('quote reads only tenant and customer scoped balance, lock optional',async()=>{
 const queries=[];const client={query:async(sql,args)=>{queries.push({sql,args});return {rows:[sql.includes('FROM customers')?{id:customer}:{points:'12.50'}]}}};
 const x=await readCustomerRedemptionQuote(client,{organizationId:org,customerId:customer,settings,currency:'UZS',total:1000,requestedPoints:5,lockCustomer:true});
 assert.equal(x.amount,500);assert.equal(x.remaining,500);assert.equal(x.maxPoints,5);
 assert.match(queries[0].sql,/FOR UPDATE/);for(const q of queries){assert.match(q.sql,/organization_id=\$1/);assert.deepEqual(q.args,[org,customer])}
 assert.throws(()=>readRedemptionPolicy(settings,'USD'),{code:'LOYALTY_CURRENCY_UNSUPPORTED'});
 assert.equal(readRedemptionPolicy({},'USD').enabled,false);
});
test('transaction helper records only a validated debit and refuses duplicate or changed quote',async()=>{
 const calls=[];let redeemed=false;
 const client={query:async(sql,args)=>{calls.push({sql,args});if(sql.startsWith('SELECT id,customer_id'))return {rows:[{id:sale,customer_id:customer,total:'1000.00'}]};if(sql.startsWith('SELECT points'))return {rows:redeemed?[{points:'-5'}]:[]};if(sql.startsWith('SELECT id FROM customers'))return {rows:[{id:customer}]};if(sql.startsWith('SELECT COALESCE'))return {rows:[{points:'12'}]};if(sql.startsWith('INSERT INTO')){redeemed=true;return {rows:[{id:'ledger'}]}};throw Error(sql)}};
 const args={organizationId:org,saleId:sale,actorId:actor,customerId:customer,settings,currency:'UZS',requestedPoints:5,expectedAmount:500};
 await assert.rejects(()=>debitSaleRedemption(client,{...args,expectedAmount:499}),{code:'LOYALTY_QUOTE_CHANGED'});
 assert.equal(calls.some(x=>x.sql.startsWith('INSERT')),false);
 assert.equal((await debitSaleRedemption(client,args)).ledgerId,'ledger');
 assert.deepEqual(calls.find(x=>x.sql.startsWith('INSERT')).args,[org,customer,sale,-5,'ZENIX_REDEEM_V1',actor]);
 await assert.rejects(()=>debitSaleRedemption(client,args),{code:'LOYALTY_ALREADY_REDEEMED'});
 assert.equal(calls.filter(x=>x.sql.startsWith('INSERT')).length,1);
});
