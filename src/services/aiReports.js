import {pool} from '../db/pool.js';
import {organizationBusinessDateISO} from '../lib/businessDate.js';
import {scopedStoreId,assertOrganizationStore} from '../lib/storeScope.js';
import {allowedTopics,authorizeTopic} from './aiPolicy.js';
const shift=(day,n)=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const safeLabel=value=>String(value||'').replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,'').slice(0,120);
export async function aiReport(user,topic,requestedStore,transactionDb){
 authorizeTopic(user,topic);const store=scopedStoreId(user,requestedStore),seller=['CASHIER','SALES'].includes(user.appRole)?user.id:null;
 const db=transactionDb||await pool.connect();
 try{
  if(!transactionDb)await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='2000ms'");
  if(store)await assertOrganizationStore(db,user.organizationId,store,{activeOnly:false});
  const org=(await db.query('SELECT timezone,settings FROM organizations WHERE id=$1',[user.organizationId])).rows[0];
  const today=organizationBusinessDateISO(org),from=shift(today,-6),old=shift(today,-29);
  const facts=[],tables=[],notes=[],eligibleInsights=[];
  const fact=(id,label,value,unit='UZS')=>facts.push({id,label,value:value===null?null:String(value),unit});
  const args=[user.organizationId,store,seller,from,today];
  const saleScope=`s.organization_id=$1 AND ($2::uuid IS NULL OR s.store_id=$2) AND ($3::uuid IS NULL OR s.seller_id=$3)`;
  const retScope=`r.organization_id=$1 AND ($2::uuid IS NULL OR r.store_id=$2) AND ($3::uuid IS NULL OR s.seller_id=$3)`;
  const topics=topic==='recommendations'?allowedTopics(user).filter(t=>t!=='recommendations'):[topic];
  for(const kind of topics){
   if(kind==='today_sales'||kind==='branches'){
    const periods=kind==='today_sales'?[...args.slice(0,3),today,today]:args;
    if(kind==='today_sales'){
     const row=(await db.query(`SELECT count(*)::text count,COALESCE(sum(s.total),0)::text gross,
      (SELECT COALESCE(sum(r.amount),0) FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id WHERE ${retScope} AND r.business_date BETWEEN $4 AND $5)::text refunds
      FROM sales s WHERE ${saleScope} AND s.business_date BETWEEN $4 AND $5`,periods)).rows[0];
     const units=value=>{const [whole,fraction='']=value.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'))};
     const net=units(row.gross)-units(row.refunds),abs=net<0?-net:net;
     fact('sales_count','Bugungi savdolar soni',row.count,'count');fact('today_gross','Bugungi yalpi savdo',row.gross);fact('today_refunds','Bugungi qaytarish',row.refunds);fact('today_net','Bugungi sof savdo',`${net<0?'-':''}${abs/100n}.${String(abs%100n).padStart(2,'0')}`);eligibleInsights.push('CHECK_WEEKLY');continue;
    }
    const rows=(await db.query(`WITH a AS(SELECT s.store_id,count(*) count,sum(s.total) gross FROM sales s WHERE ${saleScope} AND s.business_date BETWEEN $4 AND $5 GROUP BY s.store_id),
     b AS(SELECT r.store_id,sum(r.amount) refunds FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id WHERE ${retScope} AND r.business_date BETWEEN $4 AND $5 GROUP BY r.store_id)
     SELECT st.name,COALESCE(a.count,0)::text count,COALESCE(a.gross,0)::text gross,COALESCE(b.refunds,0)::text refunds,(COALESCE(a.gross,0)-COALESCE(b.refunds,0))::text net FROM stores st LEFT JOIN a ON a.store_id=st.id LEFT JOIN b ON b.store_id=st.id WHERE st.organization_id=$1 AND ($2::uuid IS NULL OR st.id=$2) ORDER BY st.name LIMIT 20`,periods)).rows;
    tables.push({title:'Oxirgi 7 biznes kunida filiallar (20 tagacha)',columns:['Filial','Savdolar','Yalpi savdo','Qaytarish','Sof savdo'],rows:rows.map(r=>[safeLabel(r.name),r.count,r.gross,r.refunds,r.net])});rows.forEach((r,i)=>fact(`branch_${i}`,'Filial sof savdosi',r.net));if(rows.length>1)eligibleInsights.push('COMPARE_BRANCHES');
   }
   if(kind==='top_products'||kind==='profit'){
    const costs=kind==='profit';
    const cost=costs?`COALESCE((SELECT sm.unit_cost FROM stock_movements sm WHERE sm.organization_id=s.organization_id AND sm.reference_type='sale' AND sm.reference_id=s.id::text AND sm.product_id=si.product_id ORDER BY sm.created_at LIMIT 1),(si.metadata->>'unitCost')::numeric)`:'NULL::numeric';
    const refundCost=costs?`COALESCE((r.metadata->>'unitCost')::numeric,(SELECT sm.unit_cost FROM stock_movements sm WHERE sm.organization_id=r.organization_id AND sm.reference_type='sale' AND sm.reference_id=r.sale_id::text AND sm.product_id=r.product_id ORDER BY sm.created_at LIMIT 1))`:'NULL::numeric';
    const rows=(await db.query(`WITH a AS(SELECT si.product_id,sum(si.quantity) qty,sum(si.line_total) amount,sum(si.quantity*(${cost})) cost,bool_and((${cost}) IS NOT NULL) known FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE ${saleScope} AND s.business_date BETWEEN $4 AND $5 GROUP BY si.product_id),
     b AS(SELECT r.product_id,sum(r.quantity) qty,sum(r.amount) amount,sum(r.quantity*(${refundCost})) cost,bool_and((${refundCost}) IS NOT NULL) known FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id WHERE ${retScope} AND r.business_date BETWEEN $4 AND $5 GROUP BY r.product_id),
     x AS(SELECT COALESCE(a.product_id,b.product_id) product_id,COALESCE(a.qty,0)-COALESCE(b.qty,0) qty,COALESCE(a.amount,0)-COALESCE(b.amount,0) revenue,
      CASE WHEN COALESCE(a.known,true) AND COALESCE(b.known,true) THEN COALESCE(a.amount,0)-COALESCE(b.amount,0)-COALESCE(a.cost,0)+COALESCE(b.cost,0) END profit FROM a FULL JOIN b ON b.product_id=a.product_id)
     SELECT p.name,x.qty::text,x.revenue::text,ROUND(x.profit,2)::text profit,count(*) OVER()::text total FROM x JOIN products p ON p.id=x.product_id AND p.organization_id=$1 ORDER BY ${costs?'x.profit DESC NULLS LAST':'x.qty DESC'},p.id LIMIT 10`,args)).rows;
    tables.push({title:costs?'Oxirgi 7 biznes kunidagi foyda (tarixiy tannarx)':'Oxirgi 7 biznes kunidagi mahsulotlar',columns:['Mahsulot','Sof miqdor',costs?'Foyda':'Sof savdo'],rows:rows.map(r=>[safeLabel(r.name),r.qty,costs?r.profit:r.revenue])});
    rows.forEach((r,i)=>fact(`${kind}_${i}`,costs?'Mahsulot foydasi':'Mahsulot sof savdosi',costs?r.profit:r.revenue));
    if(costs){notes.push('Tannarx mavjud bo‘lmagan foyda hisoblanmaydi. Jadval eng yuqori 10 natijani ko‘rsatadi.');eligibleInsights.push('FIX_COST_DATA')}else eligibleInsights.push('CHECK_WEEKLY');
   }
   if(kind==='low_stock'||kind==='dormant'){
    const rows=(await db.query(`WITH stock AS(SELECT p.id,p.name,p.min_stock,p.created_at,COALESCE(sum(ib.quantity),0) qty FROM products p LEFT JOIN inventory_balances ib ON ib.product_id=p.id AND ib.organization_id=p.organization_id AND ($2::uuid IS NULL OR ib.store_id=$2) WHERE p.organization_id=$1 AND NOT p.archived GROUP BY p.id)
     SELECT name,qty::text,min_stock::text,count(*) OVER()::text total FROM stock p WHERE ${kind==='low_stock'?'qty<=min_stock':`qty>0 AND p.created_at<($3::date::timestamp AT TIME ZONE $5) AND NOT EXISTS(SELECT 1 FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND s.organization_id=$1 AND ($2::uuid IS NULL OR s.store_id=$2) AND s.business_date BETWEEN $3 AND $4)`} ORDER BY qty,name LIMIT 10`,kind==='low_stock'?[user.organizationId,store]:[user.organizationId,store,old,today,org.timezone||'Asia/Tashkent'])).rows;
    fact(`${kind}_count`,kind==='low_stock'?'Minimal qoldiqdagi mahsulotlar':'30 kunda sotilmagan qoldiqli mahsulotlar',rows[0]?.total||'0','count');
    tables.push({title:kind==='low_stock'?'Minimal qoldiq (eng kam 10)':'30 biznes kunida sotilmagan tovarlar (10 ta)',columns:['Mahsulot','Qoldiq','Minimum'],rows:rows.map(r=>[safeLabel(r.name),r.qty,r.min_stock])});if(rows.length)eligibleInsights.push(kind==='low_stock'?'REPLENISH':'REVIEW_DORMANT');
   }
   if(kind==='expenses'){
    const date=`(e.created_at AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent')-(COALESCE(NULLIF(o.settings#>>'{workspaceSettings,businessDay,startTime}','')::time,'00:00'::time)-'00:00'::time))::date`;
    const row=(await db.query(`SELECT COALESCE(sum(e.amount),0)::text amount FROM expenses e JOIN organizations o ON o.id=e.organization_id WHERE e.organization_id=$1 AND ($2::uuid IS NULL OR e.store_id=$2) AND ${date} BETWEEN $3 AND $4`,[user.organizationId,store,from,today])).rows[0];fact('expenses','Oxirgi 7 biznes kunidagi xarajatlar',row.amount);if(Number(row.amount)>0)eligibleInsights.push('REVIEW_EXPENSES');
   }
   if(kind==='customer_debt'||kind==='supplier_debt'){
    const sql=kind==='customer_debt'?`SELECT COALESCE(sum(GREATEST(balance,0)),0)::text amount FROM(SELECT sum(amount) balance FROM customer_ledger WHERE organization_id=$1 AND ($2::uuid IS NULL OR store_id=$2) GROUP BY customer_id) x`:`SELECT COALESCE(sum(GREATEST(total-paid_amount,0)),0)::text amount FROM supplier_invoices WHERE organization_id=$1 AND ($2::uuid IS NULL OR store_id=$2)`;
    const row=(await db.query(sql,[user.organizationId,store])).rows[0];fact(kind,kind==='customer_debt'?'Mijozlarning joriy qarzi':'Ta’minotchilarning joriy qarzi',row.amount);if(store)notes.push('Qarz tanlangan filial hujjatlari kesimida; biznes bo‘yicha jami qarzdan farq qilishi mumkin.');if(Number(row.amount)>0)eligibleInsights.push(kind==='customer_debt'?'REVIEW_CUSTOMER_DEBT':'REVIEW_SUPPLIER_DEBT');
   }
  }
  if(!transactionDb)await db.query('COMMIT');return {topic,from:topic==='today_sales'?today:from,to:today,storeId:store,sellerScoped:Boolean(seller),facts,tables,notes,eligibleInsights:[...new Set(eligibleInsights)]};
 }catch(error){if(!transactionDb)await db.query('ROLLBACK');throw error}finally{if(!transactionDb)db.release()}
}
