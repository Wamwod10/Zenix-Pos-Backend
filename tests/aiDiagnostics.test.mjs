import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpError} from '../src/lib/http.js';
import {errorHandler} from '../src/middleware/error.js';
test('AI failure diagnostics expose stages but never raw provider contents',()=>{
 const logged=[],previous=console.error;let payload;
 const res={status(code){this.code=code;return this},json(value){payload=value;return value}};
 try{console.error=value=>logged.push(JSON.parse(value));errorHandler(new HttpError(502,'Javob tasdiqlanmadi','AI_INVALID_RESPONSE',{stage:'parse',reason:'invalid_message',raw:'secret-provider-text'}),{method:'POST',requestId:'synthetic-id'},res,()=>{});}finally{console.error=previous}
 assert.equal(logged[0].aiStage,'parse');assert.equal(logged[0].aiReason,'invalid_message');assert.ok(!JSON.stringify(logged).includes('secret-provider-text'));assert.equal(payload.error.code,'AI_INVALID_RESPONSE');
});
test('AI input token limits remain distinct from HTTP upload limits',()=>{
 const res={status(code){this.code=code;return this},json(value){return value}};
 assert.equal(errorHandler(new HttpError(413,'So‘rov hajmi katta','AI_TOKEN_LIMIT'),{method:'POST'},res).error.code,'AI_TOKEN_LIMIT');
});
