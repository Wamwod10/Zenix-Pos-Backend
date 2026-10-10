import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrganizationControl } from '../src/services/platformOrganization.js';

const id='00000000-0000-4000-8000-000000000001';
const actorId='00000000-0000-4000-8000-000000000002';
function fakeClient({license_status='ACTIVE',storeCount=2,pending=false}={}){
  const calls=[];
  return {
    calls,
    query:async(sql,params=[])=>{
      calls.push({sql,params});
      if(sql.startsWith('SELECT id,name,plan'))return {rows:[{id,name:'Shop',plan:'ANNUAL',license_status,expiry_date:'2099-10-08',store_limit:3,timezone:'Asia/Tashkent'}],rowCount:1};
      if(sql.startsWith('SELECT count(*)'))return {rows:[{count:storeCount}],rowCount:1};
      if(sql.includes('FROM billing_payments'))return {rows:[],rowCount:pending?1:0};
      return {rows:[],rowCount:1};
    }
  };
}

test('admin suspension obtains row lock, updates, and records full before/after audit',async()=>{
 const client=fakeClient();
 const org=await applyOrganizationControl(client,{organizationId:id,actorId,input:{action:'SUSPEND',reason:'Confirmed suspicious activity'}});
 assert.equal(org.licenseStatus,'SUSPENDED');
 assert.match(client.calls[0].sql,/FOR UPDATE/);
 const write=client.calls.find(c=>c.sql.startsWith('UPDATE organizations'));
 assert.equal(write.params[2],'SUSPENDED');
 const audit=client.calls.find(c=>c.sql.includes('INSERT INTO audit_logs'));
 assert.ok(audit);
 assert.equal(audit.params[8].licenseStatus,'ACTIVE');
 assert.equal(audit.params[9].licenseStatus,'SUSPENDED');
});
test('admin cannot shrink license store capacity below active usage',async()=>{
 const client=fakeClient({storeCount:5});
 await assert.rejects(applyOrganizationControl(client,{organizationId:id,actorId,input:{action:'SET_LICENSE',reason:'Manual account correction',plan:'MONTHLY',expiryDate:'2099-12-31',storeLimit:2}}),{code:'STORE_LIMIT_BELOW_USAGE'});
 assert.equal(client.calls.some(c=>c.sql.startsWith('UPDATE organizations')),false);
});
test('admin cannot override a license with payment awaiting review',async()=>{
 const client=fakeClient({pending:true});
 await assert.rejects(applyOrganizationControl(client,{organizationId:id,actorId,input:{action:'SET_LICENSE',reason:'Manual account correction',plan:'ANNUAL',expiryDate:'2099-12-31',storeLimit:3}}),{code:'PENDING_BILLING_REVIEW'});
 assert.equal(client.calls.some(c=>c.sql.startsWith('UPDATE organizations')),false);
});
test('restore does not activate an expired license',async()=>{
 const client=fakeClient({license_status:'SUSPENDED'});
 client.query=async function(sql,params=[]){
   client.calls.push({sql,params});
   if(sql.startsWith('SELECT id,name,plan'))return {rows:[{id,name:'Shop',plan:'MONTHLY',license_status:'SUSPENDED',expiry_date:'2020-01-01',store_limit:2,timezone:'Asia/Tashkent'}],rowCount:1};
   return {rows:[],rowCount:1};
 };
 const org=await applyOrganizationControl(client,{organizationId:id,actorId,input:{action:'RESTORE',reason:'Investigation is complete'}});
 assert.equal(org.licenseStatus,'EXPIRED');
});
test('manual license activation clears trial expiry without removing independent billing hold',async()=>{
 const client=fakeClient();
 await applyOrganizationControl(client,{organizationId:id,actorId,input:{action:'SET_LICENSE',reason:'Verified subscription correction',plan:'MONTHLY',expiryDate:'2099-12-31',storeLimit:3}});
 const write=client.calls.find(c=>c.sql.startsWith('UPDATE organizations'));
 assert.match(write.sql,/-'trialEndsAt'/);
 assert.equal(write.params[5],true);
 assert.doesNotMatch(write.sql,/billingHold/);
});
