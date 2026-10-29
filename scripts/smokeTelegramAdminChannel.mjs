// Explicit operator-only Telegram admin alert delivery smoke.
// Never runs on server startup or during CI; no database/tenant access.
import 'dotenv/config';
import {pathToFileURL} from 'node:url';

export const TEST_ALERT_MESSAGE =
  'ZENIX POS — TEST ALERT. Monitoring kanali tekshiruvi. Bu savdo, to‘lov yoki mijoz xabari emas.';

export async function sendAdminChannelSmoke({
  token,
  chatId,
  fetchImpl = fetch,
} = {}) {
  if (!token || !chatId) return {ok:false,reason:'missing_configuration'};
  try {
    const response=await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:chatId,text:TEST_ALERT_MESSAGE,disable_web_page_preview:true}),
      signal:AbortSignal.timeout(8000),
    });
    if (!response.ok) return {ok:false,reason:'transport_rejected'};
    const payload=await response.json().catch(()=>({}));
    if (payload.ok!==true||!payload.result?.message_id) return {ok:false,reason:'telegram_rejected'};
    return {ok:true,reason:'telegram_accepted'};
  } catch {
    // Never print response payloads, bot tokens, chat IDs, or driver exceptions.
    return {ok:false,reason:'transport_unavailable'};
  }
}

if (process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--send-test')) {
    console.error('No message sent. Explicitly pass --send-test to run this admin-only Telegram smoke.');
    process.exitCode=2;
  } else {
    const result=await sendAdminChannelSmoke({
      token:process.env.ZENIX_PAYMENT_BOT_TOKEN,
      chatId:process.env.ZENIX_PAYMENT_ADMIN_CHAT_ID,
    });
    console.log(result.ok
      ? 'Telegram accepted a TEST ALERT for the configured admin channel. Confirm receipt in the chat before closing operational acceptance.'
      : `Admin alert smoke did not pass: ${result.reason}. No customer data was accessed.`);
    if(!result.ok)process.exitCode=1;
  }
}
