import test from 'node:test';
import assert from 'node:assert/strict';
import {createPerformanceMetrics} from '../src/lib/performanceMetrics.js';
const {createPerformanceTimer}=await import('../src/lib/performanceTimer.js').catch(()=>({}));
test('optional timer preserves sync/promise return values and exact failures without retaining payload',async()=>{
 assert.equal(typeof createPerformanceTimer,'function');let now=0;
 const metrics=createPerformanceMetrics(),measure=createPerformanceTimer(metrics,()=>now);
 const result={secret:'never retained'};
 assert.equal(measure('ai.memory',()=>{now=2;return result}),result);
 assert.equal(await measure('ai.provider',async()=>{now=10;return result}),result);
 const error=new Error('private provider payload');
 assert.throws(()=>measure('ai.evidence',()=>{throw error}),e=>e===error);
 await assert.rejects(()=>measure('ai.tool',async()=>{throw error}),e=>e===error);
 assert.equal(metrics.snapshot()['ai.provider'].p95,8);assert.equal(metrics.snapshot()['ai.tool'].failures,1);
 assert.ok(!JSON.stringify(metrics.snapshot()).includes('private'));
 const disabled=createPerformanceTimer(createPerformanceMetrics({enabled:false}),()=>{throw new Error('disabled timer reads clock')});
 assert.equal(disabled('ai.memory',()=>result),result);
});
