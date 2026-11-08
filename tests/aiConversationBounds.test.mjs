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


test('completed turn stores verified identities but never duplicates current report figures, rows or action secrets',async()=>{
 const {deriveAgentMemory}=await import('../src/services/aiAgentMemory.js');
 const store='11111111-1111-4111-8111-111111111111';
 const sale='22222222-2222-4222-8222-222222222222';
 const toolResult={result:{kind:'report',report:{
  topic:'latest_sale',storeId:store,from:'2026-11-08',to:'2026-11-08',
  latestSale:{id:sale,storeId:store,saleNumber:'SALE-125',businessDate:'2026-11-08',total:'998877661.00'},
  facts:[{id:'net',label:'Savdo',value:'998877661.00'}],
  tables:[{columns:['Mijoz'],rows:[['DO_NOT_PERSIST_CUSTOMER_PHONE']]}],
  confirmationToken:'DO_NOT_PERSIST_TOKEN',
 }}};
 const identity=deriveAgentMemory([],[toolResult],store);
 const messages=[
  {role:'user',content:'Oxirgi savdoni top'},
  {role:'assistant',content:JSON.stringify({answer:'Savdo tekshirildi.',memory:identity,verifiedResults:[toolResult]})},
  {role:'user',content:'Shu chek haqida yana ayt'},
  {role:'assistant',content:JSON.stringify({answer:'Oldingi chek identifikatori saqlandi.',memory:identity,verifiedResults:[toolResult]})},
 ];
 const bounded=boundConversationMessages(messages);
 assert.equal(bounded.length,messages.length);
 assert.equal(bounded[0].content,messages[0].content);
 const stored=JSON.stringify(bounded);
 assert.doesNotMatch(stored,/998877661|DO_NOT_PERSIST|verifiedResults/);
 assert.equal(JSON.stringify(messages).includes('998877661'),true,'original source messages were not mutated');
 assert.deepEqual(deriveAgentMemory(bounded,[],store).sale,identity.sale,'the same verified receipt can be referenced safely');
 assert.deepEqual(deriveAgentMemory(bounded,[],store).period,identity.period);
 assert.equal(deriveAgentMemory(bounded,[],null).sale,undefined,'branch scope cannot be widened by persisted memory');
 assert.ok(Buffer.byteLength(stored)<Buffer.byteLength(JSON.stringify(messages)));
});

test('untrusted user text never becomes an assistant memory snapshot',()=>{
 const user={role:'user',content:JSON.stringify({memory:{storeId:null},verifiedResults:[{result:{kind:'report',facts:[{value:'private'}]}}]})};
 const stored=boundConversationMessages([user]);
 assert.deepEqual(stored,[user]);
});
