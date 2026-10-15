import test from 'node:test';
import assert from 'node:assert/strict';
const {createBootstrapDateParts}=await import('../src/lib/bootstrapDates.js').catch(()=>({}));
const legacy=(value,timeZone)=>{
 const date=new Date(value);
 return {dateISO:new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date),date:new Intl.DateTimeFormat('uz-UZ',{timeZone,day:'2-digit',month:'2-digit',year:'numeric'}).format(date),time:new Intl.DateTimeFormat('uz-UZ',{timeZone,hour:'2-digit',minute:'2-digit',hour12:false}).format(date)};
};
test('request-scoped bootstrap formatters preserve dates, midnight, DST and locale output',()=>{
 assert.equal(typeof createBootstrapDateParts,'function');
 for(const zone of ['Asia/Tashkent','UTC','America/New_York','Pacific/Kiritimati']){
  const format=createBootstrapDateParts(zone);
  for(const value of ['2026-01-01T19:00:00Z','2026-03-08T07:00:00Z','2026-11-01T06:00:00Z',new Date('2024-02-29T23:59:59Z')])assert.deepEqual(format(value),legacy(value,zone));
 }
});
test('formatter scope cannot leak another organization timezone',()=>{
 assert.equal(typeof createBootstrapDateParts,'function');
 const east=createBootstrapDateParts('Asia/Tashkent'),west=createBootstrapDateParts('America/New_York');
 const value='2026-01-01T20:00:00Z';
 assert.deepEqual(east(value),legacy(value,'Asia/Tashkent'));
 assert.deepEqual(west(value),legacy(value,'America/New_York'));
 assert.deepEqual(east(value),legacy(value,'Asia/Tashkent'));
 assert.deepEqual(createBootstrapDateParts()(value),east(value));
 assert.throws(()=>east('invalid'),RangeError);
});
