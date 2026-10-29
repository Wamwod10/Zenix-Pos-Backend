import test from 'node:test';
import assert from 'node:assert/strict';
import {sendAdminChannelSmoke,TEST_ALERT_MESSAGE} from '../scripts/smokeTelegramAdminChannel.mjs';

test('explicit Telegram smoke sends only a labeled admin test without tenant details',async()=>{
  const requests=[];
  const result=await sendAdminChannelSmoke({
    token:'synthetic-bot',chatId:'synthetic-admin',
    fetchImpl:async(url,options)=>{
      requests.push({url,options});
      return {ok:true,json:async()=>({ok:true,result:{message_id:101}})};
    },
  });
  assert.deepEqual(result,{ok:true,reason:'telegram_accepted'});
  assert.equal(requests.length,1);
  assert.equal(requests[0].options.method,'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body),{
    chat_id:'synthetic-admin',text:TEST_ALERT_MESSAGE,disable_web_page_preview:true,
  });
  assert.match(TEST_ALERT_MESSAGE,/TEST ALERT/);
  assert.doesNotMatch(TEST_ALERT_MESSAGE,/customer|order_id|organization_id|password/i);
});

test('no configuration never sends and failed transport never leaks bot credentials',async()=>{
  let called=0;
  const withoutConfig=await sendAdminChannelSmoke({token:'',chatId:'1',fetchImpl:()=>{called++;}});
  assert.equal(withoutConfig.ok,false);
  assert.equal(called,0);
  const failure=await sendAdminChannelSmoke({
    token:'secret-token',chatId:'synthetic-admin',
    fetchImpl:async()=>{throw new Error('secret-token and private customer details')},
  });
  assert.deepEqual(failure,{ok:false,reason:'transport_unavailable'});
  assert.doesNotMatch(JSON.stringify(failure),/secret-token|private customer/);
});
