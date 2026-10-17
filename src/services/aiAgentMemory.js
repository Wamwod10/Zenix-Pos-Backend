const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const label=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f]/.test(value);
const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const product=value=>value&&uuid(value.id)&&label(value.name,200)&&label(value.unit,40)?{id:value.id,name:value.name,unit:value.unit}:null;
const warehouse=(value,scope)=>value&&uuid(value.id)&&uuid(value.storeId)&&(scope===null||value.storeId===scope)&&label(value.name,200)?{id:value.id,storeId:value.storeId,name:value.name}:null;
const period=value=>value&&day(value.from)&&day(value.to)&&value.from<=value.to&&/^[a-z_]{1,60}$/.test(value.topic)?{from:value.from,to:value.to,topic:value.topic}:null;
const sale=(value,scope)=>value&&uuid(value.id)&&uuid(value.storeId)&&(scope===null||value.storeId===scope)&&label(value.saleNumber,200)&&day(value.businessDate)?{id:value.id,storeId:value.storeId,saleNumber:value.saleNumber,businessDate:value.businessDate}:null;
export function validateAgentMemory(value,storeId){
 const empty={storeId,product:null,warehouse:null,period:null};
 if((storeId!==null&&!uuid(storeId))||!value||value.storeId!==storeId)return empty;
 const reference=sale(value.sale,storeId);
 return {...empty,product:product(value.product),warehouse:warehouse(value.warehouse,storeId),period:period(value.period),...(reference?{sale:reference}:{})};
}
// Only persisted assistant summaries and server-verified tool results are eligible.
export function deriveAgentMemory(messages=[],toolResults=[],storeId=null){
 let memory=validateAgentMemory(null,storeId);
 const apply=entries=>{for(const entry of (Array.isArray(entries)?entries:[]).slice(-8)){
  const r=entry?.result;if(!r||typeof r!=='object')continue;
  if(r.kind==='products')memory.product=Array.isArray(r.candidates)&&r.candidates.length===1&&!r.hasMore?product({id:r.candidates[0].productId,name:r.candidates[0].name,unit:r.candidates[0].unit}):null;
  if(r.kind==='stock')memory.product=product({id:r.productId,name:r.productName,unit:r.unit});
  if(r.kind==='stock'||r.kind==='locations')memory.warehouse=Array.isArray(r.locations)&&r.locations.length===1&&!r.hasMore?warehouse({id:r.locations[0].warehouseId,storeId:r.locations[0].storeId,name:r.locations[0].warehouseName},storeId):null;
  if(r.kind==='report'){
   memory.period=period(r.report||r);
   const report=r.report||r;
   if(report.topic==='latest_sale'){
    const reference=sale(report.latestSale,storeId);
    if(reference)memory.sale=reference;else delete memory.sale;
    // A receipt with several lines never selects an arbitrary product for a write.
    memory.product=null;
   }
  }
 }};
 for(const message of (Array.isArray(messages)?messages:[]).slice(-24)){
  if(message?.role!=='assistant'||typeof message.content!=='string'||message.content.length>24000)continue;
  let summary;try{summary=JSON.parse(message.content)}catch{continue}
  if(!summary||typeof summary!=='object')continue;
  if(summary.memory){memory=validateAgentMemory(summary.memory,storeId);if(summary.memory.storeId!==storeId)continue;}
  apply(summary.verifiedResults);
 }
 apply(toolResults);
 return memory;
}
