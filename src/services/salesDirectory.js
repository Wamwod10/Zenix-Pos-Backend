import {databaseDateISO} from '../lib/businessDate.js';
export const saleView=(row,timeZone='Asia/Tashkent')=>{
 const payments=row.payments||[],mix={cash:0,card:0,transfer:0};
 for(const payment of payments)if(Object.hasOwn(mix,payment.method))mix[payment.method]+=Number(payment.amount||0);
 const methods=Object.keys(mix).filter(method=>mix[method]>0),total=Number(row.total),returnedTotal=Number(row.returned_amount||0);
 const date=new Date(row.created_at);
 return {id:row.id,saleNumber:row.sale_number,storeId:row.store_id,shiftId:row.shift_id,sellerId:row.seller_id,sellerName:row.seller_name,customer:row.customer,customerId:row.customer_id,
  total,saleTotal:total,originalTotal:total,returnedTotal,netTotal:Math.max(0,total-returnedTotal),returnStatus:returnedTotal<=0?'none':returnedTotal>=total?'returned':'partial_returned',
  paymentMethod:row.metadata?.paymentMethod==='credit'?'credit':methods.length>1?'split':methods[0]||'credit',payments,paymentBreakdown:mix,
  items:(row.items||[]).map(item=>({...item,quantity:Number(item.quantity),returnedQty:Number(item.returnedQty||0),finalPrice:Number(item.quantity)?Number(item.lineTotal)/Number(item.quantity):0})),
  businessDateISO:databaseDateISO(row.business_date),dateISO:databaseDateISO(row.business_date),createdAt:row.created_at,time:date.toLocaleTimeString('uz-UZ',{timeZone,hour:'2-digit',minute:'2-digit'}),date:date.toLocaleDateString('uz-UZ',{timeZone})};
};
export async function salesPage(client,{organizationId,storeId,businessDate,limit=30,offset=0,timeZone}){
 // Select the page before expanding products/payments. One query, no API N+1.
 const {rows}=await client.query(`WITH page AS (
   SELECT s.*,count(*) OVER() total_count FROM sales s
   WHERE s.organization_id=$1 AND s.store_id=$2 AND s.business_date=$3
   ORDER BY s.created_at DESC,s.id DESC LIMIT $4 OFFSET $5
 ) SELECT page.*,u.name seller_name,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'productId',i.product_id,'name',i.product_name,'quantity',i.quantity,'lineTotal',i.line_total,'unit',COALESCE(i.metadata->>'unit',p.unit,'dona'),'returnedQty',COALESCE((SELECT sum(r.quantity) FROM sale_returns r WHERE r.sale_id=i.sale_id AND r.product_id=i.product_id),0),'metadata',i.metadata) ORDER BY i.id) FROM sale_items i JOIN products p ON p.id=i.product_id WHERE i.sale_id=page.id),'[]'::jsonb) items,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('method',sp.method,'amount',sp.amount)) FROM sale_payments sp WHERE sp.sale_id=page.id),'[]'::jsonb) payments
 FROM page LEFT JOIN users u ON u.id=page.seller_id ORDER BY page.created_at DESC,page.id DESC`,[organizationId,storeId,businessDate,limit,offset]);
 return {items:rows.map(row=>saleView(row,timeZone)),hasMore:offset+rows.length<Number(rows[0]?.total_count||0),limit,offset};
}
