import {HttpError} from '../lib/http.js';
const captured=new Map();
const unavailable=()=>new HttpError(503,'SMS xizmati hozir mavjud emas. Keyinroq urinib ko‘ring.','SMS_UNAVAILABLE');
export function smsConfiguration(source=process.env){
 return {provider:source.SMS_PROVIDER||'',nodeEnv:source.NODE_ENV,url:source.SMS_API_URL,username:source.SMS_API_USERNAME,password:source.SMS_API_PASSWORD,sender:source.SMS_SENDER,timeoutMs:Math.min(10000,Math.max(1000,Number(source.SMS_TIMEOUT_MS)||5000)),template:source.SMS_OTP_TEMPLATE||'Zenix POS tasdiqlash kodi: {code}. Amal qilish muddati 5 daqiqa.'};
}
export function assertSmsConfigured(config){
 if(config.provider==='test'&&config.nodeEnv==='test')return;
 let url;try{url=new URL(config.url)}catch{throw unavailable()}
 if(config.provider!=='playmobile'||url.protocol!=='https:'||url.username||url.password||url.hash||!config.username||!config.password||!config.sender)throw unavailable();
}
export async function sendOtpSms({phone,code,messageId},config=smsConfiguration(),fetcher=fetch){
 assertSmsConfigured(config);
 if(config.provider==='test'){captured.set(messageId,{phone,code});return {messageId,status:'ACCEPTED',provider:'test'}}
 try{
  const response=await fetcher(config.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs||5000),headers:{'Content-Type':'application/json; charset=utf-8',Authorization:'Basic '+Buffer.from(config.username+':'+config.password).toString('base64')},body:JSON.stringify({messages:[{'message-id':messageId,recipient:phone}],sms:{originator:config.sender,ttl:300,content:{text:(config.template||'Zenix POS code: {code}').replace('{code}',code)}}})});
  if(!response.ok||(await response.text()).trim()!=='Request is received')throw unavailable();
  // Provider acceptance is a queue acknowledgment, not proof of handset delivery.
  return {messageId,status:'ACCEPTED',provider:'playmobile'};
 }catch{throw unavailable()}
}
export function takeTestSms(messageId){
 if(process.env.NODE_ENV!=='test'||process.env.SMS_PROVIDER!=='test')throw new Error('Test SMS capture disabled');
 const value=captured.get(messageId);captured.delete(messageId);return value;
}
