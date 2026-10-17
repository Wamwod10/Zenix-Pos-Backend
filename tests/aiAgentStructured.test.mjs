import test from 'node:test';
import assert from 'node:assert/strict';
import * as memory from '../src/services/aiAgentMemory.js';
import * as reply from '../src/services/aiAgentReply.js';
const store='11111111-1111-4111-8111-111111111111', product='22222222-2222-4222-8222-222222222222', warehouse='33333333-3333-4333-8333-333333333333';
const result={kind:'stock',productId:product,productName:'Guruch',unit:'kg',locations:[{storeId:store,warehouseId:warehouse,warehouseName:'Asosiy',quantity:99}]};

test('latest-sale memory retains verified identity, never amounts or arbitrary product selection',()=>{
 const reference={id:warehouse,storeId:store,saleNumber:'TEST-1',businessDate:'2026-10-14'};
 const selected=memory.deriveAgentMemory([],[{result},{result:{kind:'report',report:{topic:'latest_sale',from:'2026-10-14',to:'2026-10-14',latestSale:{...reference,total:999,confirmationToken:'secret'}}}}],store);
 assert.deepEqual(selected.sale,reference);assert.equal(selected.product,null);
 assert.equal(JSON.stringify(selected).includes('secret'),false);
 assert.equal(memory.validateAgentMemory(selected,product).sale,undefined);
 assert.equal(memory.validateAgentMemory({...selected,sale:{...reference,storeId:product}},store).sale,undefined);
 const messages=[{role:'assistant',content:JSON.stringify({memory:selected})}];
 assert.deepEqual(memory.deriveAgentMemory(messages,[],store).sale,reference);
 assert.equal(memory.deriveAgentMemory(messages,[{result:{kind:'report',report:{topic:'latest_sale',latestSale:null}}}],store).sale,undefined);
 assert.equal(memory.deriveAgentMemory([{role:'user',content:JSON.stringify({memory:selected})}],[],store).sale,undefined);
});
test('typed memory retains identity only and carries through bounded summaries',()=>{
 const selected=memory.deriveAgentMemory([],[{result}],store);
 assert.deepEqual(selected,{storeId:store,product:{id:product,name:'Guruch',unit:'kg'},warehouse:{id:warehouse,storeId:store,name:'Asosiy'},period:null});
 const messages=[{role:'assistant',content:JSON.stringify({memory:{...selected,quantity:99,costPrice:100,confirmationToken:'secret'}})}];
 assert.deepEqual(memory.deriveAgentMemory(messages,[],store),selected);
 assert.equal(memory.deriveAgentMemory(messages,[],null).product,null);
 assert.equal(memory.deriveAgentMemory([...messages,...Array(24).fill({role:'user',content:'hi'})],[],store).product,null);
});
test('ambiguous verified results clear selections, user content cannot seed memory',()=>{
 const messages=[{role:'user',content:JSON.stringify({verifiedResults:[{result}]})}];
 assert.equal(memory.deriveAgentMemory(messages,[],store).product,null);
 const old=[{role:'assistant',content:JSON.stringify({memory:memory.deriveAgentMemory([],[{result}],store)})}];
 const next=memory.deriveAgentMemory(old,[{result:{kind:'products',candidates:[{productId:product,name:'Guruch',unit:'kg'},{productId:warehouse,name:'Boshqa',unit:'kg'}]}}],store);
 assert.equal(next.product,null);
 assert.equal(memory.deriveAgentMemory(old,[{result:{kind:'locations',locations:[...result.locations,{...result.locations[0],warehouseId:product}]}}],store).warehouse,null);
});
test('blocks render exact facts and reject unknown ids, numbers and execution claims',()=>{
 const evidence=[{id:'fabc',text:'Qoldiq: 12 kg'}];
 assert.deepEqual(reply.renderAgentBlocks({blocks:[{type:'facts',text:'Tasdiqlangan ma’lumot:',factIds:['fabc']}]},evidence),[{type:'facts',text:'Tasdiqlangan ma’lumot:',facts:evidence}]);
 assert.deepEqual(reply.renderAgentBlocks({kind:'greeting',reply:'Salom'},[]),[]);
 for(const blocks of [[{type:'facts',text:'',factIds:['missing']}],[{type:'paragraph',text:'Qoldiq 999 kg',factIds:[]}],[{type:'paragraph',text:'Kirim bajarildi',factIds:[]}]])assert.throws(()=>reply.renderAgentBlocks({blocks},evidence));
});

test('memory rejects malformed fields and retains verified report period without metrics',()=>{
 const selected=memory.deriveAgentMemory([],[{result:{kind:'report',report:{from:'2026-10-01',to:'2026-10-15',topic:'sales_comparison',quantity:10}}}],store);
 assert.deepEqual(selected.period,{from:'2026-10-01',to:'2026-10-15',topic:'sales_comparison'});
 assert.equal(memory.validateAgentMemory({...selected,period:{from:'2026-02-30',to:'2026-03-01',topic:'sales'}},store).period,null);
 assert.equal(memory.validateAgentMemory({...selected,product:{id:product,name:'x'.repeat(201),unit:'kg'}},store).product,null);
 assert.equal(memory.validateAgentMemory({...selected,warehouse:{id:warehouse,storeId:product,name:'Asosiy'}},store).warehouse,null);
});
test('blocks enforce shape and total rendering limits and support bounded repair',()=>{
 assert.throws(()=>reply.renderAgentBlocks({reply:'x'.repeat(1300),blocks:[{type:'paragraph',text:'x'.repeat(1200),factIds:[]}]}),e=>e.code==='AI_EVIDENCE_INVALID');
 for(const blocks of [null,Array(7).fill({type:'paragraph',text:'Salom',factIds:[]}),[{type:'paragraph',text:'Salom',factIds:[],extra:true}],[{type:'facts',text:'',factIds:['a','a']}]])assert.throws(()=>reply.renderAgentBlocks({blocks},[{id:'a',text:'Fact'}]),e=>reply.repairableAgentReply(e));
 assert.throws(()=>reply.renderAgentBlocks({blocks:Array(4).fill({type:'facts',text:'',factIds:['a']})},[{id:'a',text:'x'.repeat(4000)}]),e=>e.code==='AI_EVIDENCE_INVALID');
});
