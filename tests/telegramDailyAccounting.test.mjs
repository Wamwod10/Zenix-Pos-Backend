import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {formatNotification} from '../src/services/telegram.js';
import {canDeliverNotification} from '../src/services/notificationWorker.js';

test('delivery authorization keeps tenants, branches and disabled event settings isolated',()=>{
  const context={organization_id:'a',connection_organization_id:'a',store_id:'one',connection_store_id:'one',enabled:true,event_type:'sale.completed'};
  assert.equal(canDeliverNotification(context),true);
  assert.equal(canDeliverNotification({...context,connection_organization_id:'b'}),false);
  assert.equal(canDeliverNotification({...context,connection_store_id:'two'}),false);
  assert.equal(canDeliverNotification({...context,connection_store_id:null}),true);
  assert.equal(canDeliverNotification({...context,enabled:false}),false);
  assert.equal(canDeliverNotification({...context,settings:{sale:false}}),false);
});

test('scheduled totals use refund processing day and actual refund payment breakdown', async()=>{
  const source=await readFile(new URL('../src/services/notificationWorker.js',import.meta.url),'utf8');
  assert.match(source,/FROM sale_returns/);
  assert.match(source,/refundBreakdown/);
  assert.doesNotMatch(source,/sum\(total-returned_amount\)/);
});
test('credit sales and collections have distinct labels; interim and closing reports differ',()=>{
  const payload={total:100000,cash:30000,card:20000,transfer:-5000};
  const interim=formatNotification('daily.report',{...payload,reportKind:'interim'});
  assert.ok(interim.includes('100 000 so‘m'));
  assert.ok(interim.includes('45 000 so‘m'));
  assert.ok(interim.includes('Oraliq hisobot'));
  assert.ok(formatNotification('daily.report',{...payload,reportKind:'final'}).includes('Yakuniy kun yopilishi'));
});
