import { databaseDateISO } from '../lib/businessDate.js';
import { HttpError } from '../lib/http.js';

const n=value=>Number(value||0);
const saleJSON=`jsonb_build_object('id',s.id,'saleNumber',s.sale_number,'storeId',s.store_id,'shiftId',s.shift_id,'sellerId',s.seller_id,'sellerAccountId',s.seller_id,'sellerName',u.name,'seller',u.name,'store',st.name,'total',s.total,'saleTotal',s.total,'subtotal',s.subtotal,'discountTotal',s.discount_amount,'returnedAmount',s.returned_amount,'returnedTotal',s.returned_amount,'businessDateISO',s.business_date::text,'dateISO',s.business_date::text,'createdAt',s.created_at,'customer',s.customer,'status',s.status,
  'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',si.id,'productId',si.product_id,'name',si.product_name,'category',p.category,'quantity',si.quantity,'qty',si.quantity,'unitPrice',si.unit_price,'finalPrice',si.unit_price*(1-si.discount_percent/100),'discountPercent',si.discount_percent,'lineTotal',si.line_total,'metadata',si.metadata,'unitCost',COALESCE((SELECT sm.unit_cost FROM stock_movements sm WHERE sm.organization_id=s.organization_id AND sm.reference_type='sale' AND sm.reference_id=s.id::text AND sm.product_id=si.product_id ORDER BY sm.created_at LIMIT 1),(si.metadata->>'unitCost')::numeric,0),'returnedQty',COALESCE((SELECT sum(r.quantity) FROM sale_returns r WHERE r.organization_id=s.organization_id AND r.sale_id=s.id AND r.product_id=si.product_id),0))) FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=s.id),'[]'::jsonb),
  'payments',COALESCE((SELECT jsonb_agg(jsonb_build_object('method',sp.method,'amount',sp.amount)) FROM sale_payments sp WHERE sp.sale_id=s.id),'[]'::jsonb))`;

export function reportOptions(input={}) {
  const result={...input};
  for(const key of ['from','to']) {
    if(!result[key]){result[key]=null;continue;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(result[key])||Number.isNaN(Date.parse(result[key]))||new Date(`${result[key]}T12:00:00Z`).toISOString().slice(0,10)!==result[key])throw new HttpError(400,'Invalid report date','INVALID_REPORT_DATE');
  }
  if(result.from&&result.to&&result.from>result.to)throw new HttpError(400,'Invalid report range','INVALID_REPORT_DATE');
  result.limit=Math.min(500,Math.max(1,Number(input.limit)||100));
  result.offset=Math.max(0,Number(input.offset)||0);
  if(!Number.isInteger(result.limit)||!Number.isInteger(result.offset))throw new HttpError(400,'Invalid pagination','INVALID_PAGINATION');
  return result;
}

// Revenue follows document business dates. Payment capture and actual refund
// allocations are separate cashflow; shift movements must not be deducted again.
export async function financeReport(db,input) {
  const {organizationId,storeId=null,sellerId=null,from,to,limit,offset}=reportOptions(input);
  const args=[organizationId,storeId,sellerId,from,to,input.search||null,input.paymentMethod||null,input.shiftId||null];
  const filters=`AND ($6::text IS NULL OR s.id::text ILIKE '%'||$6||'%' OR s.sale_number ILIKE '%'||$6||'%' OR u.name ILIKE '%'||$6||'%' OR s.customer::text ILIKE '%'||$6||'%' OR EXISTS(SELECT 1 FROM sale_items si WHERE si.sale_id=s.id AND si.product_name ILIKE '%'||$6||'%')) AND ($7::text IS NULL OR ($7='split' AND (SELECT count(DISTINCT method) FROM sale_payments WHERE sale_id=s.id AND amount>0)>1) OR ($7<>'split' AND EXISTS(SELECT 1 FROM sale_payments WHERE sale_id=s.id AND method=$7 AND amount>0) AND (SELECT count(DISTINCT method) FROM sale_payments WHERE sale_id=s.id AND amount>0)=1)) AND ($8::uuid IS NULL OR s.shift_id=$8)`;
  const base=`FROM sales s LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN stores st ON st.id=s.store_id WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.store_id=$2) AND ($3::uuid IS NULL OR s.seller_id=$3) ${filters}`;
  const salePeriod=`AND ($4::date IS NULL OR s.business_date >= $4) AND ($5::date IS NULL OR s.business_date <= $5)`;
  const retBase=`FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN users actor ON actor.id=r.created_by LEFT JOIN stores st ON st.id=s.store_id WHERE r.organization_id=$1 AND ($2::uuid IS NULL OR r.store_id=$2) AND ($3::uuid IS NULL OR r.created_by=$3) AND ($4::date IS NULL OR r.business_date >= $4) AND ($5::date IS NULL OR r.business_date <= $5) ${filters}`;
  const sales=(await db.query(`SELECT ${saleJSON} data ${base} ${salePeriod} ORDER BY s.business_date DESC,s.created_at DESC,s.id DESC LIMIT $9 OFFSET $10`,[...args,limit,offset])).rows.map(row=>mapSale(row.data));
  const returns=(await db.query(`SELECT r.*,actor.name actor_name,p.name product_name,${saleJSON} source_sale ${retBase.replace(' WHERE',' LEFT JOIN products p ON p.id=r.product_id WHERE')} ORDER BY r.business_date DESC,r.created_at DESC,r.id DESC LIMIT $9 OFFSET $10`,[...args,limit,offset])).rows.map(row=>({...row.metadata,id:row.id,saleId:row.sale_id,storeId:row.store_id,productId:row.product_id,productName:row.product_name,quantity:n(row.quantity),amount:n(row.amount),businessDateISO:databaseDateISO(row.business_date),dateISO:databaseDateISO(row.business_date),createdAt:row.created_at,createdBy:row.created_by,actorName:row.actor_name,refundMethod:row.refund_method,reason:row.reason,sourceSale:mapSale(row.source_sale)}));
  const totals=(await db.query(`SELECT count(*) sale_count,COALESCE(sum(s.total),0) gross,COALESCE(sum(s.returned_amount),0) lifetime_returns ${base} ${salePeriod}`,args)).rows[0];
  const retTotals=(await db.query(`SELECT count(*) return_count,COALESCE(sum(r.amount),0) refunds,COALESCE(sum((r.metadata->'refundBreakdown'->>'cash')::numeric),0) cash,COALESCE(sum((r.metadata->'refundBreakdown'->>'card')::numeric),0) card,COALESCE(sum((r.metadata->'refundBreakdown'->>'transfer')::numeric),0) transfer ${retBase}`,args)).rows[0];
  const payment=(await db.query(`SELECT sp.method,sum(sp.amount) amount FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id LEFT JOIN users u ON u.id=s.seller_id WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.store_id=$2) AND ($3::uuid IS NULL OR s.seller_id=$3) ${salePeriod} ${filters} GROUP BY sp.method`,args)).rows;
  const cashflow={cash:0-n(retTotals.cash),card:0-n(retTotals.card),transfer:0-n(retTotals.transfer)};
  for(const row of payment)if(Object.hasOwn(cashflow,row.method))cashflow[row.method]+=n(row.amount);
  const cost=(await db.query(`SELECT COALESCE(sum((SELECT sum(si.quantity*COALESCE((SELECT sm.unit_cost FROM stock_movements sm WHERE sm.organization_id=s.organization_id AND sm.reference_type='sale' AND sm.reference_id=s.id::text AND sm.product_id=si.product_id ORDER BY sm.created_at LIMIT 1),(si.metadata->>'unitCost')::numeric,0)) FROM sale_items si WHERE si.sale_id=s.id)),0) amount ${base} ${salePeriod}`,args)).rows[0];
  const refundCost=(await db.query(`SELECT COALESCE(sum(r.quantity*COALESCE((r.metadata->>'unitCost')::numeric,(SELECT sm.unit_cost FROM stock_movements sm WHERE sm.organization_id=r.organization_id AND sm.reference_type='sale' AND sm.reference_id=r.sale_id::text AND sm.product_id=r.product_id ORDER BY sm.created_at LIMIT 1),0)),0) amount ${retBase}`,args)).rows[0];
  const expenseDate=`(e.created_at AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent') - (COALESCE(NULLIF(o.settings#>>'{workspaceSettings,businessDay,startTime}','')::time,'00:00'::time)-'00:00'::time))::date`;
  const expenseBase=`FROM expenses e JOIN organizations o ON o.id=e.organization_id WHERE e.organization_id=$1 AND ($2::uuid IS NULL OR e.store_id=$2) AND ($3::date IS NULL OR ${expenseDate}>=$3) AND ($4::date IS NULL OR ${expenseDate}<=$4)`;
  const expenseArgs=[organizationId,storeId,from,to];
  const expenseTotals=(await db.query(`SELECT count(*) count,COALESCE(sum(e.amount),0) amount ${expenseBase}`,expenseArgs)).rows[0];
  const expenses=(await db.query(`SELECT e.*,${expenseDate}::text date_iso ${expenseBase} ORDER BY e.created_at DESC,e.id DESC LIMIT $5 OFFSET $6`,[...expenseArgs,limit,offset])).rows.map(row=>({...row.metadata,id:row.id,storeId:row.store_id,title:row.title,category:row.category,amount:n(row.amount),dateISO:row.date_iso,businessDateISO:row.date_iso,createdAt:row.created_at,paymentMethod:row.payment_method}));
  const netRevenue=n(totals.gross)-n(retTotals.refunds),grossProfit=netRevenue-n(cost.amount)+n(refundCost.amount);
  return {aggregate:{saleCount:n(totals.sale_count),returnCount:n(retTotals.return_count),grossRevenue:n(totals.gross),refundAmount:n(retTotals.refunds),netRevenue,grossProfit,expenseTotal:n(expenseTotals.amount),netProfit:grossProfit-n(expenseTotals.amount),lifetimeReturnedAmount:n(totals.lifetime_returns),lifetimeNetRevenue:n(totals.gross)-n(totals.lifetime_returns),cashflow},sales,returns,expenses,pagination:{limit,offset,total:n(totals.sale_count),returnTotal:n(retTotals.return_count),expenseTotal:n(expenseTotals.count),hasMore:offset+limit<Math.max(n(totals.sale_count),n(retTotals.return_count),n(expenseTotals.count))}};
}

function mapSale(row){
  const mix={cash:0,card:0,transfer:0,credit:0};
  for(const p of row.payments||[])mix[p.method]=(mix[p.method]||0)+n(p.amount);
  const methods=Object.keys(mix).filter(method=>mix[method]>0);
  return {...row,paymentBreakdown:methods.length>1?mix:null,paymentMethod:methods.length>1?'split':methods[0]||'cash'};
}

export async function shiftSalesStats(db,organizationId,storeId=null){
  const {rows}=await db.query(`SELECT s.shift_id,COALESCE(sum(s.total),0) total_sales,
    COALESCE(sum(p.cash),0) cash_sales,COALESCE(sum(p.card),0) card_sales,COALESCE(sum(p.transfer),0) transfer_sales
    FROM sales s LEFT JOIN LATERAL (SELECT sum(amount) FILTER(WHERE method='cash') cash,sum(amount) FILTER(WHERE method='card') card,sum(amount) FILTER(WHERE method='transfer') transfer FROM sale_payments WHERE sale_id=s.id) p ON true
    WHERE s.organization_id=$1 AND ($2::uuid IS NULL OR s.store_id=$2) AND s.shift_id IS NOT NULL GROUP BY s.shift_id`,[organizationId,storeId]);
  return new Map(rows.map(row=>[row.shift_id,{totalSales:n(row.total_sales),cashSales:n(row.cash_sales),cardSales:n(row.card_sales),transferSales:n(row.transfer_sales)}]));
}
