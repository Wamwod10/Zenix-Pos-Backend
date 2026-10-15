import test from 'node:test';
import assert from 'node:assert/strict';
import {boundConversationMessages} from '../src/services/aiConversationStore.js';
test('conversation bounds discard whole oldest turns instead of erasing all context',()=>{
 const turns=Array.from({length:20},(_,i)=>[{role:'user',content:`Savol ${i}`},{role:'assistant',content:JSON.stringify({answer:`Javob ${i}`,verifiedResults:[]})}]).flat();
 const result=boundConversationMessages(turns);
 assert.equal(result.length,24);assert.equal(result[0].content,'Savol 8');assert.match(result.at(-1).content,/Javob 19/);
});
test('oversized tool history preserves latest question and answer within the byte budget',()=>{
 const turns=[{role:'user',content:'Unda nega qoldiq nol?'},{role:'assistant',content:JSON.stringify({answer:'Jami mahsulotlar va minimumdagi mahsulotlar boshqa ko‘rsatkichlar.',verifiedResults:[{result:{rows:Array(5000).fill('synthetic')}}]})}];
 const result=boundConversationMessages(turns);
 assert.equal(result.length,2);assert.match(result[1].content,/boshqa ko‘rsatkichlar/);assert.ok(Buffer.byteLength(JSON.stringify(result))<=12000);
});

test('multibyte conversation keeps identity memory while trimming prose to the actual byte cap',()=>{
 const memory={storeId:null,product:{id:'11111111-1111-4111-8111-111111111111',name:'😀'.repeat(100),unit:'kg'},warehouse:null,period:null};
 const messages=[{role:'user',content:'😀'.repeat(1000)},{role:'assistant',content:JSON.stringify({answer:'😀'.repeat(2400),memory,verifiedResults:[]})}];
 const bounded=boundConversationMessages(messages,6000);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=6000);assert.deepEqual(JSON.parse(bounded[1].content).memory,memory);assert.equal(bounded[0].content,messages[0].content);
});
