import {z} from 'zod';
import {scopedStoreId,assertOrganizationStore} from '../lib/storeScope.js';
import {organizationBusinessDateISO} from '../lib/businessDate.js';
import {authorizeTopic,allowedTopics} from './aiPolicy.js';
import {aiReport} from './aiReports.js';

const storeId=z.string().uuid().nullable(),date=z.string().date();
const bounded=(from,to)=>from<=to&&(Date.parse(to)-Date.parse(from))/86400000<366;
export const READ_REPORT_SCHEMAS=Object.freeze({
 get_restock_advice:z.object({storeId}).strict(),
 get_business_overview:z.object({storeId}).strict(),
 get_warehouse_summary:z.object({storeId}).strict(),
 compare_sales_periods:z.object({storeId,from:date,to:date,comparisonFrom:date,comparisonTo:date}).strict().refine(v=>bounded(v.from,v.to)&&bounded(v.comparisonFrom,v.comparisonTo),'Periods must be ordered and at most 366 days'),
 get_product_sales_report:z.object({storeId,ranking:z.enum(['top','slow']),from:date.nullable(),to:date.nullable()}).strict().refine(v=>(v.from===null&&v.to===null)||(v.from!==null&&v.to!==null&&bounded(v.from,v.to)),'Supply both dates; period must be ordered and at most 366 days'),
});
const label=value=>String(value||'').replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g,'').slice(0,120);
const shift=(day,n)=>{const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};

// The caller must recheck the actor in the same transaction before entering here.
export async function readAgentReport(db,user,name,input){
 if(name==='get_restock_advice')authorizeTopic(user,'low_stock');
 authorizeTopic(user,name==='get_business_overview'?'recommendations':name==='get_warehouse_summary'?'low_stock':'top_products');
 const store=scopedStoreId(user,input.storeId),seller=['CASHIER','SALES'].includes(user.appRole)?user.id:null;
 if(store)await assertOrganizationStore(db,user.organizationId,store,{activeOnly:false});
 const org=(await db.query('SELECT timezone,settings FROM organizations WHERE id=$1',[user.organizationId])).rows[0];
 const today=organizationBusinessDateISO(org),facts=[],tables=[],notes=[];
 const report={topic:name,from:input.from||today,to:input.to||today,storeId:store,sellerScoped:Boolean(seller),facts,tables,notes,eligibleInsights:[]};
 const fact=(id,text,value,unit='UZS')=>facts.push({id,label:text,value:value===null?null:String(value),unit});
 if(name==='get_business_overview'){
  // Same transaction/snapshot and the same topic permissions as individual reads.
  // Profit is a bounded product ranking, never an invented total business profit.
  const allowed=new Set(allowedTopics(user));report.topic='business_overview';report.from=shift(today,-6);
  for(const topic of ['today_sales','profit','expenses','customer_debt','supplier_debt']){
   if(!allowed.has(topic))continue;
   const component=await aiReport(user,topic,store,db),snapshot=topic.endsWith('_debt');
   const period={from:snapshot?today:component.from,to:component.to};
   for(const [i,f] of component.facts.slice(0,topic==='profit'?3:4).entries())facts.push({...f,id:`${topic}_${f.id}`,label:topic==='profit'?`${component.tables[0]?.rows[i]?.[0]||'Mahsulot'} foydasi`:f.label,...period});
   for(const table of component.tables.slice(0,1))tables.push({...table,rows:table.rows.slice(0,3),...period});
   if(topic==='profit')notes.push('Tarixiy tannarx yetishmasa mahsulot foydasi hisoblanmaydi. Umumiy ko‘rinishda foyda bo‘yicha eng yuqori 3 mahsulotgacha beriladi; bu biznesning jami yoki sof foydasi emas.');
  }
  if(allowed.has('low_stock')){
   const inventory=await readAgentReport(db,user,'get_warehouse_summary',{storeId:store});
   for(const f of inventory.facts)facts.push({...f,id:`inventory_${f.id}`,from:today,to:today});
   notes.push(...inventory.notes);
  }
  notes.push('Faqat ruxsat etilgan bo‘limlar jamlangan. Savdo bugungi, mahsulot foydasi va xarajatlar haftalik, qarz va qoldiq joriy holatdir. Sabablar yoki kelajak talabi bu raqamlardan isbotlanmaydi.');
  return report;
 }
 if(name==='get_warehouse_summary'){
  const row=(await db.query(`WITH stock AS (
   SELECT p.id,p.min_stock,COALESCE(sum(b.quantity),0) quantity FROM products p
   LEFT JOIN (SELECT wb.product_id,wb.quantity FROM warehouse_balances wb
    JOIN warehouses w ON w.organization_id=wb.organization_id AND w.store_id=wb.store_id AND w.id=wb.warehouse_id AND w.active=true
    JOIN stores s ON s.organization_id=wb.organization_id AND s.id=wb.store_id AND s.active=true
    WHERE wb.organization_id=$1 AND ($2::uuid IS NULL OR wb.store_id=$2)) b ON b.product_id=p.id
   WHERE p.organization_id=$1 AND p.archived=false GROUP BY p.id)
   SELECT count(*)::text catalog,count(*) FILTER(WHERE quantity>0)::text available,count(*) FILTER(WHERE quantity<=min_stock)::text low,
   (SELECT count(*)::text FROM stores WHERE organization_id=$1 AND active=true AND ($2::uuid IS NULL OR id=$2)) stores,
   (SELECT count(*)::text FROM warehouses w JOIN stores s ON s.organization_id=w.organization_id AND s.id=w.store_id AND s.active=true WHERE w.organization_id=$1 AND w.active=true AND ($2::uuid IS NULL OR w.store_id=$2)) warehouses FROM stock`,[user.organizationId,store])).rows[0];
  for(const [id,text,key] of [['catalog_products','Faol katalog mahsulotlari','catalog'],['available_products','Musbat qoldiqli mahsulotlar','available'],['low_stock_count','Minimum yoki undan past qoldiqli mahsulotlar','low'],['store_count','Faol filiallar','stores'],['count','Faol omborlar','warehouses']])fact(`warehouse_${id}`,text,row[key],'count');
  notes.push('Katalog mahsulotlari tashkilotdagi faol mahsulotlar soni; mavjud va minimal qoldiq tanlangan faol filial va omborlar bo‘yicha. Turli birliklar miqdori jamlanmaydi.');
  return report;
 }
 const scope=`s.organization_id=$1 AND ($2::uuid IS NULL OR s.store_id=$2) AND ($3::uuid IS NULL OR s.seller_id=$3)`;
 const returns=`r.organization_id=$1 AND ($2::uuid IS NULL OR r.store_id=$2) AND ($3::uuid IS NULL OR s.seller_id=$3)`;
 if(name==='get_restock_advice'){
  report.from=shift(today,-27);report.to=today;
  const rows=(await db.query(`WITH sold AS (
   SELECT si.product_id,sum(si.quantity) quantity,count(DISTINCT s.business_date) days,min(s.business_date) first_day
   FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE ${scope} AND s.business_date BETWEEN $4::date AND $5::date GROUP BY si.product_id
  ), returned AS (
   SELECT r.product_id,sum(r.quantity) quantity FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id
   WHERE ${returns} AND r.business_date BETWEEN $4::date AND $5::date GROUP BY r.product_id
  ), stock AS (
   SELECT wb.product_id,sum(wb.quantity) quantity FROM warehouse_balances wb
   JOIN warehouses w ON w.organization_id=wb.organization_id AND w.store_id=wb.store_id AND w.id=wb.warehouse_id AND w.active=true
   JOIN stores st ON st.organization_id=wb.organization_id AND st.id=wb.store_id AND st.active=true
   WHERE wb.organization_id=$1 AND ($2::uuid IS NULL OR wb.store_id=$2) GROUP BY wb.product_id
  ), observed AS (
   SELECT p.id,p.name,p.unit,COALESCE(sold.quantity,0)-COALESCE(returned.quantity,0) net_quantity,
   COALESCE(sold.days,0) days,COALESCE(stock.quantity,0) available,
   COALESCE(sold.days>=7 AND sold.first_day<=$5::date-14 AND (p.created_at AT TIME ZONE $6)::date<=$4::date,false) enough_history,
   CASE WHEN lower(trim(p.unit)) IN ('piece','dona','pcs') THEN 0 WHEN lower(trim(p.unit)) IN ('kg','g','l','ml','m','m2','m3') THEN 3 ELSE NULL END unit_scale
   FROM products p LEFT JOIN sold ON sold.product_id=p.id LEFT JOIN returned ON returned.product_id=p.id LEFT JOIN stock ON stock.product_id=p.id
   WHERE p.organization_id=$1 AND p.archived=false AND ($3::uuid IS NULL OR sold.product_id IS NOT NULL OR returned.product_id IS NOT NULL)
  ), advice AS (
   SELECT *,CASE WHEN enough_history AND unit_scale IS NOT NULL AND net_quantity>=0 AND available>=0 THEN
    ceil(GREATEST(0::numeric,net_quantity*7/28-available)*power(10::numeric,unit_scale))/power(10::numeric,unit_scale) ELSE NULL END suggested
   FROM observed
  ) SELECT name,unit,net_quantity::text,days::text,available::text,round(suggested,unit_scale)::text suggested,enough_history,unit_scale,(net_quantity<0 OR available<0) invalid_data
   FROM advice ORDER BY (suggested>0) DESC NULLS LAST,name,id LIMIT 10`,[user.organizationId,store,seller,report.from,today,org.timezone||'Asia/Tashkent'])).rows;
  tables.push({title:'Tarixiy savdo asosida zaxirani to‘ldirish tavsiyasi (10 tagacha mahsulot)',columns:['Mahsulot','Birlik','Sof sotilgan miqdor (28 kun)','Savdo bo‘lgan kunlar','Mavjud qoldiq','Tavsiya etilgan xarid miqdori'],rows:rows.map(r=>[label(r.name),label(r.unit),r.net_quantity,r.days,r.available,r.suggested])});
  rows.forEach((r,i)=>{
   fact(`restock_${i}_suggested_quantity`,`${label(r.name)} uchun tavsiya etilgan xarid miqdori`,r.suggested,label(r.unit));
   if(!r.enough_history)notes.push(`${label(r.name)}: savdo tarixi yetarli emas. Kamida 7 alohida kunda savdo bo‘lishi, davrdagi birinchi savdo kamida 14 kun oldin kuzatilishi va mahsulot davr boshida mavjud bo‘lishi kerak. Xarid miqdori hozircha noma’lum.`);
   if(r.unit_scale===null)notes.push(`${label(r.name)}: o‘lchov birligi qo‘llab-quvvatlanmaydi; xarid miqdori noma’lum.`);
   if(r.invalid_data)notes.push(`${label(r.name)}: sof sotilgan miqdor yoki ombor qoldig‘i manfiy; savdo, qaytarish va qoldiq hujjatlarini tekshiring. Xarid miqdori noma’lum.`);
  });
  notes.push('Taxminiy hisob: bugunni qo‘shgan holda oxirgi 28 biznes sanasidagi savdo asosida 7 kunlik rejalashtirish. Tavsiya miqdori = 0 va (sof sotilgan miqdor / 28 × 7 − faol omborlardagi joriy qoldiq) qiymatlarining kattasi. Natija dona uchun butun songacha, o‘lchanadigan birliklar uchun 0.001 aniqlikkacha yuqoriga yaxlitlanadi. Qaytarishlar qaytarish biznes sanasi bo‘yicha hisoblanadi. Turli birliklar alohida saqlanadi. Tarixiy savdo kelajakdagi talabni isbotlamaydi. Yetkazib berish muddati va xavfsizlik zaxirasi haqida ma’lumot yo‘q. Bu faqat tavsiya; buyurtma yoki to‘lov yaratilmaydi.');
  if(seller)notes.push('Savdo tarixi faqat shu sotuvchiga tegishli; qoldiq ruxsat etilgan filial bo‘yicha berilgan.');
  return report;
 }
 if(name==='compare_sales_periods'){
  const row=(await db.query(`WITH periods AS(SELECT 'current' key,$4::date from_date,$5::date to_date UNION ALL SELECT 'comparison',$6::date,$7::date),
   totals AS(SELECT p.key,
    (SELECT count(*) FROM sales s WHERE ${scope} AND s.business_date BETWEEN p.from_date AND p.to_date) count,
    (SELECT COALESCE(sum(s.total),0) FROM sales s WHERE ${scope} AND s.business_date BETWEEN p.from_date AND p.to_date) gross,
    (SELECT COALESCE(sum(r.amount),0) FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id WHERE ${returns} AND r.business_date BETWEEN p.from_date AND p.to_date) refunds FROM periods p),
   x AS(SELECT *,gross-refunds net FROM totals)
   SELECT c.count::text current_count,c.gross::text current_gross,c.refunds::text current_refunds,c.net::text current_net,
    b.count::text comparison_count,b.gross::text comparison_gross,b.refunds::text comparison_refunds,b.net::text comparison_net,
    (c.count-b.count)::text delta_count,(c.gross-b.gross)::text delta_gross,(c.refunds-b.refunds)::text delta_refunds,(c.net-b.net)::text delta_net
   FROM x c CROSS JOIN x b WHERE c.key='current' AND b.key='comparison'`,[user.organizationId,store,seller,input.from,input.to,input.comparisonFrom,input.comparisonTo])).rows[0];
  report.comparisonFrom=input.comparisonFrom;report.comparisonTo=input.comparisonTo;
  const metricNames={count:'savdolar soni',gross:'yalpi savdo',refunds:'qaytarishlar',net:'sof savdo'};
  for(const period of ['current','comparison','delta'])for(const metric of ['count','gross','refunds','net']){
   fact(`period_${period}_${metric}`,`${{current:'Joriy davr',comparison:'Taqqoslash davri',delta:'Joriy − taqqoslash farqi'}[period]} ${metricNames[metric]}`,row[`${period}_${metric}`],metric==='count'?'count':'UZS');
   if(period!=='delta')Object.assign(facts.at(-1),{from:period==='current'?input.from:input.comparisonFrom,to:period==='current'?input.to:input.comparisonTo});
  }
  tables.push({title:'Savdo davrlari',columns:['Davr','Boshlanish','Tugash','Savdolar','Yalpi savdo','Qaytarish','Sof savdo'],rows:[['current',input.from,input.to,row.current_count,row.current_gross,row.current_refunds,row.current_net],['comparison',input.comparisonFrom,input.comparisonTo,row.comparison_count,row.comparison_gross,row.comparison_refunds,row.comparison_net]]});
  notes.push('Farq = joriy davr − taqqoslash davri. Qaytarishlar qaytarish biznes sanasiga kiradi. Davr uzunliklari farq qilishi mumkin; natijalar normallashtirilmagan.');
  return report;
 }
 report.from=input.from||shift(today,-6);report.to=input.to||today;
 const rows=(await db.query(`WITH a AS(SELECT si.product_id,sum(si.quantity) quantity,sum(si.line_total) amount FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE ${scope} AND s.business_date BETWEEN $4 AND $5 GROUP BY si.product_id),
  b AS(SELECT r.product_id,sum(r.quantity) quantity,sum(r.amount) amount FROM sale_returns r JOIN sales s ON s.id=r.sale_id AND s.organization_id=r.organization_id WHERE ${returns} AND r.business_date BETWEEN $4 AND $5 GROUP BY r.product_id),
  x AS(SELECT p.id,p.name,p.unit,COALESCE(a.quantity,0)-COALESCE(b.quantity,0) quantity,COALESCE(a.amount,0)-COALESCE(b.amount,0) revenue FROM products p LEFT JOIN a ON a.product_id=p.id LEFT JOIN b ON b.product_id=p.id WHERE p.organization_id=$1 AND (NOT p.archived OR a.product_id IS NOT NULL OR b.product_id IS NOT NULL) AND ($3::uuid IS NULL OR a.product_id IS NOT NULL OR b.product_id IS NOT NULL))
  SELECT name,unit,quantity::text,revenue::text FROM x ORDER BY revenue ${input.ranking==='slow'?'ASC':'DESC'},id LIMIT 10`,[user.organizationId,store,seller,report.from,report.to])).rows;
 tables.push({title:input.ranking==='slow'?'Sof savdosi eng kam mahsulotlar (10 tagacha)':'Sof savdosi eng yuqori mahsulotlar (10 tagacha)',columns:['Mahsulot','Birlik','Sof miqdor','Sof savdo'],rows:rows.map(r=>[label(r.name),label(r.unit),r.quantity,r.revenue])});
 rows.forEach((r,i)=>{fact(`product_sales_${i}_quantity`,`${label(r.name)} sof miqdori`,r.quantity,label(r.unit));fact(`product_sales_${i}_revenue`,`${label(r.name)} sof savdosi`,r.revenue)});
 notes.push('Saralash sof savdo summasi bo‘yicha; turli mahsulot birliklari miqdori taqqoslanmaydi. Qaytarishlar qaytarish biznes sanasiga kiradi. Nol savdo sabab yoki kelajak talabi haqida dalil emas.');
 if(seller)notes.push('Sotuvchi kesimida faqat shu davrda sotuvchining savdo yoki qaytarish hujjatlaridagi mahsulotlar ko‘rsatiladi.');
 return report;
}
