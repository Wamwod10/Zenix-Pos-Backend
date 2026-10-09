import {HttpError} from '../lib/http.js';

const fail=(code,message)=>{throw new HttpError(409,message,code);};
const key=value=>String(value??'').toLowerCase();
const selections=(value,code)=>{
  if(value==null)return [];
  if(!Array.isArray(value))fail(code,'Mahsulot kuzatuv tanlovi noto‘g‘ri');
  return value;
};
const ordered=entries=>[...entries].sort((a,b)=>key(a.id??a.batchId).localeCompare(key(b.id??b.batchId)));

/** Plan under row locks before the sale is written. Parent transaction already
 * locks org -> shift -> balances in product-ID order. Tracking locks are always
 * serial IDs then batch IDs, independently of cashier selection/FEFO order. */
export async function planSaleTracking(client,{organizationId,storeId,productId,quantity,stock,metadata={}}){
  const scope=[organizationId,storeId,productId];
  const belongs=row=>row.organization_id===organizationId&&row.store_id===storeId&&row.product_id===productId;
  const units=(await client.query('SELECT * FROM product_serials WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 ORDER BY id ASC FOR UPDATE',scope)).rows.filter(belongs);
  const lots=(await client.query('SELECT * FROM inventory_batches WHERE organization_id=$1 AND store_id=$2 AND product_id=$3 ORDER BY id ASC FOR UPDATE',scope)).rows.filter(belongs);
  const availableUnits=units.filter(row=>row.status==='IN_STOCK');
  const availableLots=lots.filter(row=>Number(row.remaining_quantity)>0);
  const serialInput=selections(metadata.tracking?.serials??metadata.tracking?.serializedUnits??metadata.serializedUnits,'SERIAL_SELECTION_INVALID');
  const batchInput=selections(metadata.tracking?.batches,'BATCH_SELECTION_INVALID');
  if((availableUnits.length||serialInput.length)&&!Number.isInteger(quantity))fail('SERIAL_QUANTITY_INVALID','Serial / IMEI uchun miqdor butun son bo‘lishi kerak');
  let chosenUnits;
  if(serialInput.length){
    const seen=new Set();chosenUnits=[];
    for(const entry of serialInput){
      const selectionId=entry&&typeof entry==='object'?(entry.id??entry.serialId):null;
      const value=typeof entry==='string'?entry:entry?.serial;
      const row=availableUnits.find(unit=>selectionId?key(unit.id)===key(selectionId):key(unit.serial)===key(value));
      if(!row||(value&&key(row.serial)!==key(value)))fail('SERIAL_NOT_AVAILABLE','Tanlangan Serial / IMEI joriy filialda mavjud emas');
      if(seen.has(row.id))fail('DUPLICATE_SERIAL','Serial / IMEI takrorlangan');
      seen.add(row.id);chosenUnits.push(row);
    }
    const fullySerialized=availableUnits.length>0&&availableUnits.length+1e-9>=stock;
    if(chosenUnits.length>quantity||(fullySerialized&&chosenUnits.length!==quantity))fail('SERIAL_QUANTITY_MISMATCH','Serial / IMEI soni sotuv miqdoriga mos emas');
  }else chosenUnits=availableUnits.slice(0,Math.min(quantity,availableUnits.length));
  const availableQuantity=availableLots.reduce((sum,row)=>sum+Number(row.remaining_quantity),0);
  let chosenLots=[];
  if(batchInput.length){
    const seen=new Set();let selectedQuantity=0;
    for(const entry of batchInput){
      const row=availableLots.find(lot=>key(lot.id)===key(entry?.batchId??entry?.id));
      const take=Number(entry?.quantity);
      if(!row||!Number.isFinite(take)||take<=0||take>Number(row.remaining_quantity)+1e-9)fail('BATCH_NOT_AVAILABLE','Tanlangan partiya joriy filialda mavjud emas yoki qoldiq yetarli emas');
      if(seen.has(row.id))fail('DUPLICATE_BATCH','Partiya tanlovi takrorlangan');
      seen.add(row.id);chosenLots.push({row,quantity:take});selectedQuantity+=take;
    }
    if(Math.abs(selectedQuantity-Math.min(quantity,availableQuantity))>1e-9)fail('BATCH_QUANTITY_MISMATCH','Tanlangan partiya miqdori sotuv miqdoriga mos emas');
  }else{
    const time=value=>value?new Date(value).getTime():Number.MAX_SAFE_INTEGER;
    const fefo=[...availableLots].sort((a,b)=>time(a.expiry_date)-time(b.expiry_date)||time(a.created_at)-time(b.created_at)||key(a.id).localeCompare(key(b.id)));
    let left=quantity;
    for(const row of fefo){if(left<=1e-9)break;const take=Math.min(left,Number(row.remaining_quantity));chosenLots.push({row,quantity:take});left-=take;}
  }
  let offset=0;
  return {quantity,serials:chosenUnits.map((row,index)=>({id:row.id,serial:row.serial,unitOffset:index})),batches:chosenLots.map(({row,quantity:take})=>{
    const allocation={batchId:row.id,batchNo:row.batch_no||'',expiryDate:row.expiry_date||null,quantity:take,startOffset:offset,endOffset:offset+take};offset+=take;return allocation;
  }),untrackedQty:Math.max(0,quantity-chosenUnits.length)};
}

export async function consumeSaleTracking(client,{organizationId,storeId,productId,saleId,tracking}){
  for(const entry of ordered(tracking.serials)){
    const result=await client.query("UPDATE product_serials SET status='SOLD',sale_id=$5,updated_at=now() WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND product_id=$4 AND status='IN_STOCK'",[entry.id,organizationId,storeId,productId,saleId]);
    if(result.rowCount!==1)fail('SERIAL_NOT_AVAILABLE','Tanlangan Serial / IMEI endi mavjud emas');
  }
  for(const entry of ordered(tracking.batches)){
    const result=await client.query('UPDATE inventory_batches SET remaining_quantity=remaining_quantity-$5 WHERE id=$1 AND organization_id=$2 AND store_id=$3 AND product_id=$4 AND remaining_quantity>=$5',[entry.batchId,organizationId,storeId,productId,entry.quantity]);
    if(result.rowCount!==1)fail('BATCH_NOT_AVAILABLE','Tanlangan partiya qoldig‘i o‘zgargan');
  }
}
