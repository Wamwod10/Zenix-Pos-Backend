import test from 'node:test';
import assert from 'node:assert/strict';
const otp=await import('../src/services/trialOtp.js').catch(()=>({}));
const sms=await import('../src/services/smsProvider.js').catch(()=>({}));
test('OTP phone and HMAC bind code to challenge, with timing-safe rejection',()=>{
 assert.equal(otp.normalizeOtpPhone('+998 90 123 45 67'),'998901234567');
 assert.throws(()=>otp.normalizeOtpPhone('998901234567garbage'));
 const key='x'.repeat(48),digest=otp.otpDigest(key,'challenge','phone','123456');
 assert.equal(otp.matchesOtp(digest,digest),true);
 assert.equal(otp.matchesOtp(digest,otp.otpDigest(key,'other','phone','123456')),false);
 assert.equal(otp.matchesOtp(digest,''),false);
 assert.throws(()=>otp.otpDigest('', 'id','phone','123456'));
});
test('SMS provider fails closed without config and test provider cannot run outside test',async()=>{
 await assert.rejects(()=>sms.sendOtpSms({phone:'998901234567',code:'123456',messageId:'abc'},{}),e=>e.code==='SMS_UNAVAILABLE');
 await assert.rejects(()=>sms.sendOtpSms({phone:'998901234567',code:'123456',messageId:'abc'},{provider:'test',nodeEnv:'production'}));
});
test('PlayMobile HTTPS request authenticates server-side and accepted is not delivered',async()=>{
 let sent;const config={provider:'playmobile',nodeEnv:'test',url:'https://sms.example.test/send',username:'operator',password:'secret',sender:'ZENIX',timeoutMs:1000};
 const result=await sms.sendOtpSms({phone:'998901234567',code:'123456',messageId:'abc'},config,async(url,options)=>{sent={url,options};return new Response('Request is received',{status:200})});
 assert.equal(result.status,'ACCEPTED');assert.equal(result.messageId,'abc');
 assert.equal(JSON.parse(sent.options.body).messages[0].recipient,'998901234567');
 assert.match(sent.options.headers.Authorization,/^Basic /);
 await assert.rejects(()=>sms.sendOtpSms({phone:'998901234567',code:'123456',messageId:'abc'},config,async()=>new Response('password detail',{status:401})),e=>e.code==='SMS_UNAVAILABLE'&&!e.message.includes('password'));
 await assert.rejects(()=>sms.sendOtpSms({phone:'998901234567',code:'123456',messageId:'abc'},{...config,url:'http://unsafe.test/send'}));
});
