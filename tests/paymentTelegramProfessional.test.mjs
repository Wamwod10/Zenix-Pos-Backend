import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaymentTelegramClient,formatPaymentReviewMessage} from '../src/services/paymentTelegram.js';
import {deliverPaymentEvent,paymentRetryState} from '../src/services/paymentNotificationWorker.js';
import {handlePaymentCallback} from '../src/routes/paymentTelegram.js';
import {derivePaymentReviewToken} from '../src/services/paymentTelegram.js';

const payment={id:'p',organization_name:'A & <B>',owner_name:'Ali',owner_phone:'+99890',plan:'ANNUAL',amount:3300000,order_id:'ZX-1',submitted_at:'2026-10-15T06:58:00Z',status:'APPROVED',reviewed_at:'2026-10-15T07:02:00Z'};
const success=result=>({ok:true,status:200,json:async()=>({ok:true,result})});
for(const mime of ['image/jpeg','application/pdf'])test(`${mime} edit keeps receipt, full payment data and removes buttons`,async()=>{
  const calls=[];
  const client=createPaymentTelegramClient({token:'private-token',fetchImpl:async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return success({message_id:88});}});
  await client.editPaymentReviewMessage('-1',77,formatPaymentReviewMessage(payment,{telegramUsername:'admin'}),{hasCaption:true});
  assert.equal(calls[0].method,'editMessageCaption');
  assert.ok(calls[0].body.caption.includes('A &amp; &lt;B&gt;'));
  assert.deepEqual(calls[0].body.reply_markup,{inline_keyboard:[]});
  assert.ok(!calls.some(c=>/delete|editMessageMedia/.test(c.method)));
});
for(const mime of ['image/jpeg','application/pdf'])test(`${mime} oversized initial review retains receipt and puts actions on full text`,async()=>{
  const calls=[];
  const client=createPaymentTelegramClient({token:'private-token',fetchImpl:async(url,options)=>{
    calls.push({method:url.split('/').at(-1),body:options.body instanceof FormData ? options.body : JSON.parse(options.body)});
    return success({message_id:calls.length,chat:{id:-1},...(calls.length===1?{document:{file_id:'receipt'}}:{})});
  }});
  const oversized={...payment,status:'REVIEW',organization_name:'&'.repeat(160),owner_name:'<'.repeat(160),order_id:'<&'.repeat(80),receipt_type:mime,receipt_content:Buffer.from('test')};
  assert.ok(formatPaymentReviewMessage(oversized).length>1024);
  const result=await client.sendPaymentReview(oversized,'opaque','-1');
  assert.equal(result.message_id,2);assert.equal(calls[0].method,mime==='image/jpeg'?'sendPhoto':'sendDocument');
  assert.ok(calls[0].body.get('caption').length<=1024);assert.equal(calls[0].body.get('reply_markup'),null);
  assert.equal(calls[1].method,'sendMessage');assert.equal(calls[1].body.reply_parameters.message_id,1);
  assert.equal(calls[1].body.reply_markup.inline_keyboard[0][0].callback_data,'pa:opaque');
});
test('oversized receipt caption keeps full decision in a checkpointed reply; retry reuses it',async()=>{
  const calls=[];let checkpoint;
  const client=createPaymentTelegramClient({token:'private-token',fetchImpl:async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return success({message_id:88});}});
  const text=formatPaymentReviewMessage({...payment,organization_name:'😀'.repeat(160),owner_name:'Ali'.repeat(90),status:'REJECTED',reject_reason:'&'.repeat(500)},{telegramUsername:'admin'});
  assert.ok(text.length>1024);
  await client.editPaymentReviewMessage('-1',77,text,{hasCaption:true,onDetailsMessage:async id=>{checkpoint=id;}});
  assert.equal(checkpoint,88);assert.equal(calls[0].method,'sendMessage');
  assert.ok(calls[1].body.caption.length<=1024);
  assert.ok(calls[1].body.caption.includes('TO‘LOV RAD ETILDI'));
  await client.editPaymentReviewMessage('-1',77,text,{hasCaption:true,detailsMessageId:checkpoint});
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal(calls[2].method,'editMessageText');
});
test('temporary edit outage leaves event unsent and a retry succeeds without replaying finance',async()=>{
  const event={id:'e',event_type:'billing.payment_review_updated',payload:{payment,actor:{telegramUsername:'admin'},chatId:'-1',messageId:77,hasCaption:true}};
  let writes=0,attempts=0;
  const db={query:async()=>{writes++;return {rows:[]};}};
  const edit=async()=>{if(++attempts===1)throw Error('temporary failure');};
  await assert.rejects(deliverPaymentEvent(db,event,undefined,edit),/temporary/);
  assert.equal(writes,0);assert.equal(paymentRetryState(0,Error('temporary failure')).status,'retry');
  await deliverPaymentEvent(db,event,undefined,edit);assert.equal(writes,1);
});
test('transport exceptions never reveal bot credentials',async()=>{
  const client=createPaymentTelegramClient({token:'private-token',fetchImpl:async()=>{throw Error('https://api.telegram.org/botprivate-token/sendMessage');}});
  await assert.rejects(client.answerPaymentCallback('c','ok'),e=>!e.message.includes('private-token'));
});
test('concurrent admins and subsequent callbacks produce one committed decision',async()=>{
  const token=derivePaymentReviewToken('p','secret');let status='REVIEW',commits=0;
  const db={query:async()=>({rows:[{id:'p',status,telegram_review_token_expires_at:'2099-01-01'}]})};
  const reviewPayment=async()=>{await Promise.resolve();if(status!=='REVIEW')return {outcome:'alreadyReviewed'};status='APPROVED';commits++;return {outcome:'approved',telegramUpdateQueued:true};};
  const deps={db,reviewPayment,answerCallback:async()=>{},editMessage:async()=>{throw Error('must use outbox');},config:{paymentAdminChatId:'-1',paymentAdminUserIds:['1','2']}};
  const update=id=>({callback_query:{id:String(id),from:{id},data:`pa:${token}`,message:{message_id:77,chat:{id:'-1'},document:{}}}});
  const outcomes=await Promise.all([handlePaymentCallback(update(1),deps),handlePaymentCallback(update(2),deps)]);
  assert.equal(commits,1);assert.deepEqual(outcomes.sort(),['alreadyReviewed','approved']);
  assert.equal(await handlePaymentCallback(update(1),deps),'alreadyReviewed');
});
