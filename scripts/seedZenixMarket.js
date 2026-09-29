import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import pg from "pg";
import { assertOperationalSafety, buildDemoPlan, parseSeedMode, resolveAnchorDate, SEED_KEY, stableUuid, validateTargetProfile } from "../src/services/zenixMarketSeed.js";

loadEnv({ path:resolve(process.cwd(), "../.env.local") });
loadEnv({ path:resolve(process.cwd(), ".env") });

const EXPECTED_LOGIN = "umidjon";
const EXPECTED_ORGANIZATION = "Zenix Market";
const marker = (extra={}) => ({ seedKey:SEED_KEY, ...extra });
const money = (value) => Number(Number(value).toFixed(2));

function previousDate(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

async function assertOwnedUpsert(result, label) {
  if (result.rowCount !== 1) throw new Error(`${label} conflicted with a non-seed row; no data was committed`);
}

async function operationalSafetySnapshot(client,{orgId,storeId,productIds,anchorDate}){
  return (await client.query(`SELECT
    (SELECT count(*)::int FROM stock_movements WHERE organization_id=$1 AND store_id=$2 AND product_id=ANY($3::uuid[]) AND COALESCE(metadata->>'seedKey','')<>$4) non_seed_movements,
    (SELECT count(*)::int FROM sales WHERE organization_id=$1 AND store_id=$2 AND business_date BETWEEN $5::date-6 AND $5::date AND COALESCE(metadata->>'seedKey','')<>$4) non_seed_window_sales,
    (SELECT count(*)::int FROM sale_returns WHERE organization_id=$1 AND store_id=$2 AND business_date BETWEEN $5::date-6 AND $5::date) returns,
    (SELECT count(*)::int FROM shifts WHERE organization_id=$1 AND store_id=$2 AND status='open' AND COALESCE(metadata->>'seedKey','')<>$4) foreign_open_shifts,
    (SELECT count(*)::int FROM business_days WHERE organization_id=$1 AND store_id=$2 AND business_date BETWEEN $5::date-6 AND $5::date AND COALESCE(metadata->>'seedKey','')<>$4) foreign_business_days,
    (SELECT count(*)::int FROM inventory_balances ib WHERE ib.organization_id=$1 AND ib.store_id=$2 AND ib.product_id=ANY($3::uuid[]) AND ib.quantity<>(SELECT COALESCE(sum(sm.quantity),0) FROM stock_movements sm WHERE sm.organization_id=$1 AND sm.store_id=$2 AND sm.product_id=ib.product_id)) ledger_mismatches`,[orgId,storeId,productIds,SEED_KEY,anchorDate])).rows[0];
}

async function verify(client, { organizationId, storeId, plan }) {
  const result = await client.query(`
    WITH scoped_sales AS (
      SELECT s.* FROM sales s
      WHERE s.organization_id=$1 AND s.business_date BETWEEN $3::date-6 AND $3::date
        AND s.metadata->>'seedKey'=$2
    ), pay AS (
      SELECT sp.method,COALESCE(sum(sp.amount),0) amount
      FROM sale_payments sp JOIN scoped_sales s ON s.id=sp.sale_id GROUP BY sp.method
    ), sale_math AS (
      SELECT s.id,s.total,
        COALESCE((SELECT sum(si.line_total) FROM sale_items si WHERE si.sale_id=s.id),0) item_total,
        COALESCE((SELECT sum(sp.amount) FROM sale_payments sp WHERE sp.sale_id=s.id),0) payment_total
      FROM scoped_sales s
    ), stock_math AS (
      SELECT ib.product_id,ib.quantity,
        COALESCE((SELECT sum(sm.quantity) FROM stock_movements sm
          WHERE sm.organization_id=ib.organization_id AND sm.store_id=ib.store_id
            AND sm.product_id=ib.product_id AND sm.metadata->>'seedKey'=$2),0) movement_quantity
      FROM inventory_balances ib JOIN products p ON p.id=ib.product_id
      WHERE ib.organization_id=$1 AND ib.store_id=$4 AND p.metadata->>'seedKey'=$2
    ), movement_chain AS (
      SELECT before_quantity,lag(after_quantity) OVER(PARTITION BY product_id ORDER BY created_at,id) previous_after
      FROM stock_movements WHERE organization_id=$1 AND store_id=$4 AND metadata->>'seedKey'=$2
    )
    SELECT
      (SELECT count(*)::int FROM products WHERE organization_id=$1 AND metadata->>'seedKey'=$2) products,
      (SELECT count(DISTINCT category)::int FROM products WHERE organization_id=$1 AND metadata->>'seedKey'=$2) categories,
      (SELECT count(*)::int FROM scoped_sales) sales,
      (SELECT count(DISTINCT business_date)::int FROM scoped_sales) sale_days,
      (SELECT COALESCE(sum(total),0) FROM scoped_sales) revenue,
      (SELECT COALESCE(sum(amount),0) FROM pay WHERE method='cash') cash,
      (SELECT COALESCE(sum(amount),0) FROM pay WHERE method='card') card,
      (SELECT COALESCE(sum(amount),0) FROM pay WHERE method='transfer') transfer,
      (SELECT COALESCE(sum(quantity),0) FROM stock_math) stock_units,
      (SELECT count(*)::int FROM stock_math WHERE quantity<0) negative_stock,
      (SELECT count(*)::int FROM stock_math WHERE quantity<>movement_quantity) stock_mismatches,
      (SELECT count(*)::int FROM sale_math WHERE total<>item_total OR total<>payment_total) sale_mismatches,
      (SELECT count(*)::int FROM sale_items si JOIN scoped_sales s ON s.id=si.sale_id WHERE si.line_total<>si.unit_price*si.quantity) line_mismatches,
      (SELECT count(*)::int FROM movement_chain WHERE COALESCE(previous_after,0)<>before_quantity) movement_chain_mismatches,
      (SELECT count(*)::int FROM inventory_batches b JOIN products p ON p.id=b.product_id JOIN inventory_balances ib ON ib.store_id=b.store_id AND ib.product_id=b.product_id
         WHERE b.organization_id=$1 AND b.store_id=$4 AND p.metadata->>'seedKey'=$2 AND b.remaining_quantity<>ib.quantity) batch_mismatches,
      (SELECT count(*)::int FROM inventory_balances ib JOIN products p ON p.id=ib.product_id WHERE ib.organization_id=$1 AND ib.store_id=$4 AND p.metadata->>'seedKey'=$2) balance_rows,
      (SELECT COALESCE(sum((si.unit_price-(si.metadata->>'costPrice')::numeric)*si.quantity),0)
         FROM sale_items si JOIN scoped_sales s ON s.id=si.sale_id) gross_profit,
      (SELECT count(*)::int FROM business_days WHERE organization_id=$1 AND store_id=$4
         AND business_date BETWEEN $3::date-6 AND $3::date AND metadata->>'seedKey'=$2) closed_days,
      (SELECT count(*)::int FROM suppliers WHERE organization_id=$1 AND metadata->>'seedKey'=$2) suppliers,
      (SELECT count(*)::int FROM supplier_invoices WHERE organization_id=$1 AND metadata->>'seedKey'=$2) invoices,
      (SELECT count(*)::int FROM expenses WHERE organization_id=$1 AND metadata->>'seedKey'=$2) expenses,
      (SELECT count(*)::int FROM shifts WHERE organization_id=$1 AND metadata->>'seedKey'=$2) shifts,
      (SELECT count(*)::int FROM (SELECT sp.sale_id FROM sale_payments sp JOIN scoped_sales s ON s.id=sp.sale_id GROUP BY sp.sale_id HAVING count(*)>1) x) split_sales,
      (SELECT count(*)::int FROM supplier_invoice_items sii JOIN supplier_invoices i ON i.id=sii.invoice_id WHERE i.organization_id=$1 AND i.metadata->>'seedKey'=$2) invoice_items,
      (SELECT count(*)::int FROM supplier_payments WHERE organization_id=$1 AND metadata->>'seedKey'=$2) supplier_payments,
      (SELECT count(*)::int FROM supplier_invoices i WHERE i.organization_id=$1 AND i.metadata->>'seedKey'=$2 AND i.total<>(SELECT COALESCE(sum(sii.total),0) FROM supplier_invoice_items sii WHERE sii.invoice_id=i.id)) invoice_total_mismatches,
      (SELECT count(*)::int FROM supplier_invoices i WHERE i.organization_id=$1 AND i.metadata->>'seedKey'=$2 AND i.paid_amount<>(SELECT COALESCE(sum(sp.amount),0) FROM supplier_payments sp WHERE sp.invoice_id=i.id)) supplier_payment_mismatches
  `, [organizationId, SEED_KEY, plan.days[6].date, storeId]);
  const summary = result.rows[0];
  const expectedStock = plan.finalStock.reduce((sum,row)=>sum+row.quantity,0);
  if (Number(summary.products)!==100 || Number(summary.categories)!==10 || Number(summary.sales)!==126 || Number(summary.sale_days)!==7) throw new Error(`Seed count verification failed: ${JSON.stringify(summary)}`);
  if (Number(summary.revenue)!==plan.summary.revenue || Number(summary.cash)!==plan.summary.payments.cash || Number(summary.card)!==plan.summary.payments.card || Number(summary.transfer)!==plan.summary.payments.transfer) throw new Error("Revenue/payment verification failed");
  if (Number(summary.stock_units)!==expectedStock || Number(summary.balance_rows)!==100 || Number(summary.negative_stock)!==0 || Number(summary.stock_mismatches)!==0 || Number(summary.sale_mismatches)!==0 || Number(summary.line_mismatches)!==0 || Number(summary.movement_chain_mismatches)!==0 || Number(summary.batch_mismatches)!==0) throw new Error(`Inventory/sale consistency verification failed: ${JSON.stringify(summary)}`);
  if (Number(summary.gross_profit)!==plan.summary.grossProfit || Number(summary.closed_days)!==6 || Number(summary.suppliers)!==3 || Number(summary.invoices)!==3 || Number(summary.expenses)!==7 || Number(summary.shifts)!==7 || Number(summary.split_sales)!==28 || Number(summary.invoice_items)!==100 || Number(summary.supplier_payments)!==3 || Number(summary.invoice_total_mismatches)!==0 || Number(summary.supplier_payment_mismatches)!==0) throw new Error(`History verification failed: ${JSON.stringify(summary)}`);
  return Object.fromEntries(Object.entries(summary).map(([key,value]) => [key, typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value]));
}

async function seed(client, plan, target) {
  const { organizationId:orgId, storeId, userId } = target;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${SEED_KEY}:${orgId}`]);
  const store = await client.query("SELECT id FROM stores WHERE id=$1 AND organization_id=$2 AND active=true FOR UPDATE", [storeId,orgId]);
  if (store.rowCount!==1) throw new Error("The profile's bound store is not active in the target organization");
  for(const day of plan.days) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${orgId}:${storeId}:${day.date}`]);

  const skus = plan.catalog.map((p)=>p.sku), barcodes=plan.catalog.map((p)=>p.barcode), productIds=plan.catalog.map((p)=>stableUuid(orgId,`product:${p.index}`));
  const collisions = await client.query(`SELECT id,sku,barcode FROM products WHERE organization_id=$1 AND (lower(sku)=ANY($2::text[]) OR barcode=ANY($3::text[]) OR id=ANY($4::uuid[])) AND COALESCE(metadata->>'seedKey','')<>$5`, [orgId,skus.map(s=>s.toLowerCase()),barcodes,productIds,SEED_KEY]);
  if (collisions.rowCount) throw new Error(`Product collision with ${collisions.rowCount} existing non-seed row(s)`);
  await client.query("SELECT product_id FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND product_id=ANY($3::uuid[]) FOR UPDATE",[orgId,storeId,productIds]);
  assertOperationalSafety(await operationalSafetySnapshot(client,{orgId,storeId,productIds,anchorDate:plan.days[6].date}));

  const receivedAt = `${previousDate(plan.days[0].date)}T10:00:00+05:00`;
  for (const product of plan.catalog) {
    const id=stableUuid(orgId,`product:${product.index}`), metadata=marker({supplierId:stableUuid(orgId,`supplier:${product.index%3}`)});
    const upsert=await client.query(`INSERT INTO products(id,organization_id,name,sku,barcode,category,brand,unit,cost_price,sell_price,wholesale_price,min_stock,metadata,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sku=EXCLUDED.sku,barcode=EXCLUDED.barcode,category=EXCLUDED.category,brand=EXCLUDED.brand,unit=EXCLUDED.unit,cost_price=EXCLUDED.cost_price,sell_price=EXCLUDED.sell_price,wholesale_price=EXCLUDED.wholesale_price,min_stock=EXCLUDED.min_stock,metadata=EXCLUDED.metadata,archived=false,archived_at=NULL,updated_at=now()
      WHERE products.organization_id=EXCLUDED.organization_id AND products.metadata->>'seedKey'=$15 RETURNING id`,
      [id,orgId,product.name,product.sku,product.barcode,product.category,product.brand,product.unit,product.costPrice,product.sellPrice,product.wholesalePrice,product.minStock,metadata,receivedAt,SEED_KEY]);
    await assertOwnedUpsert(upsert,`product ${product.sku}`);
  }

  const supplierNames=["Toshkent Food Distribution","Baraka Savdo Ta’minot","Orient Daily Goods"];
  for(let i=0;i<3;i+=1){
    const id=stableUuid(orgId,`supplier:${i}`);
    const upsert=await client.query(`INSERT INTO suppliers(id,organization_id,name,phone,contact_name,telegram,metadata,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,contact_name=EXCLUDED.contact_name,telegram=EXCLUDED.telegram,metadata=EXCLUDED.metadata,archived=false,updated_at=now()
      WHERE suppliers.organization_id=EXCLUDED.organization_id AND suppliers.metadata->>'seedKey'=$9 RETURNING id`,[id,orgId,supplierNames[i],`+998 71 200 0${i+1} 0${i+1}`,i===0?"Azizbek":i===1?"Dilshod":"Malika",`@zenix_supplier_${i+1}`,marker({index:i}),receivedAt,SEED_KEY]);
    await assertOwnedUpsert(upsert,`supplier ${i}`);
  }

  for(let supplierIndex=0;supplierIndex<3;supplierIndex+=1){
    const supplierId=stableUuid(orgId,`supplier:${supplierIndex}`), invoiceId=stableUuid(orgId,`invoice:${supplierIndex}`);
    const products=plan.catalog.filter((p)=>p.index%3===supplierIndex);
    const total=products.reduce((sum,p)=>sum+p.received*p.costPrice,0), paid=supplierIndex===1?money(total*0.8):total;
    const invoice=await client.query(`INSERT INTO supplier_invoices(id,organization_id,supplier_id,store_id,invoice_no,total,paid_amount,due_date,note,metadata,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET total=EXCLUDED.total,paid_amount=EXCLUDED.paid_amount,due_date=EXCLUDED.due_date,note=EXCLUDED.note,metadata=EXCLUDED.metadata
      WHERE supplier_invoices.organization_id=EXCLUDED.organization_id AND supplier_invoices.metadata->>'seedKey'=$12 RETURNING id`,[invoiceId,orgId,supplierId,storeId,`ZM-KIRIM-${supplierIndex+1}`,total,paid,supplierIndex===1?plan.days[6].date:null,"Demo do‘kon boshlang‘ich kirimi",marker({supplierIndex}),receivedAt,SEED_KEY]);
    await assertOwnedUpsert(invoice,`invoice ${supplierIndex}`);
    const paymentId=stableUuid(orgId,`supplier-payment:${supplierIndex}`);
    await client.query(`INSERT INTO supplier_payments(id,organization_id,supplier_id,invoice_id,store_id,amount,method,note,metadata,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'transfer',$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET amount=EXCLUDED.amount,note=EXCLUDED.note,metadata=EXCLUDED.metadata
      WHERE supplier_payments.organization_id=EXCLUDED.organization_id AND supplier_payments.metadata->>'seedKey'=$11`,[paymentId,orgId,supplierId,invoiceId,storeId,paid,"Boshlang‘ich kirim to‘lovi",marker({supplierIndex}),userId,receivedAt,SEED_KEY]);
    for(const product of products){
      const productId=stableUuid(orgId,`product:${product.index}`), itemId=stableUuid(orgId,`invoice-item:${product.index}`);
      await client.query(`INSERT INTO supplier_invoice_items(id,invoice_id,product_id,product_name,quantity,unit_cost,total,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET quantity=EXCLUDED.quantity,unit_cost=EXCLUDED.unit_cost,total=EXCLUDED.total,metadata=EXCLUDED.metadata`,[itemId,invoiceId,productId,product.name,product.received,product.costPrice,product.received*product.costPrice,marker()]);
    }
  }

  const running=plan.catalog.map((p)=>p.received);
  for(const product of plan.catalog){
    const productId=stableUuid(orgId,`product:${product.index}`), movementId=stableUuid(orgId,`receive:${product.index}`), invoiceId=stableUuid(orgId,`invoice:${product.index%3}`);
    await client.query(`INSERT INTO stock_movements(id,organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,unit_cost,reference_type,reference_id,reason,metadata,created_by,created_at)
      VALUES($1,$2,$3,$4,'receive',$5,0,$5,$6,'purchase',$7,'Boshlang‘ich ombor kirimi',$8,$9,$10) ON CONFLICT(id) DO UPDATE SET quantity=EXCLUDED.quantity,before_quantity=0,after_quantity=EXCLUDED.after_quantity,unit_cost=EXCLUDED.unit_cost,metadata=EXCLUDED.metadata
      WHERE stock_movements.organization_id=EXCLUDED.organization_id AND stock_movements.metadata->>'seedKey'=$11`,[movementId,orgId,storeId,productId,product.received,product.costPrice,invoiceId,marker(),userId,receivedAt,SEED_KEY]);
  }

  const dayAggregates=new Map(plan.days.map((d)=>[d.date,{total:0,cash:0,card:0,transfer:0,count:0}]));
  const shiftIds=plan.days.map((day)=>stableUuid(orgId,`shift:${day.date}`));
  for(const day of plan.days){
    const shiftId=stableUuid(orgId,`shift:${day.date}`), daySales=plan.sales.filter((s)=>s.businessDate===day.date);
    const cash=daySales.flatMap(s=>s.payments).filter(p=>p.method==="cash").reduce((a,p)=>a+p.amount,0), opening=300000;
    const isToday=day.date===plan.days[6].date;
    const shift=await client.query(`INSERT INTO shifts(id,organization_id,store_id,cashier_id,register_key,status,opening_cash,expected_cash,actual_cash,difference,opened_at,closed_at,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,opening_cash=EXCLUDED.opening_cash,expected_cash=EXCLUDED.expected_cash,actual_cash=EXCLUDED.actual_cash,difference=EXCLUDED.difference,opened_at=EXCLUDED.opened_at,closed_at=EXCLUDED.closed_at,metadata=EXCLUDED.metadata
      WHERE shifts.organization_id=EXCLUDED.organization_id AND shifts.metadata->>'seedKey'=$14 RETURNING id`,[shiftId,orgId,storeId,userId,`seed:${day.date}`,isToday?"open":"closed",opening,isToday?null:opening+cash,isToday?null:opening+cash,isToday?null:0,`${day.date}T07:45:00+05:00`,isToday?null:`${day.date}T21:30:00+05:00`,marker({businessDate:day.date}),SEED_KEY]);
    await assertOwnedUpsert(shift,`shift ${day.date}`);
  }

  for(const sale of plan.sales){
    const saleId=stableUuid(orgId,`sale:${sale.key}`), shiftId=shiftIds[sale.dayIndex], saleNumber=`ZM-DEMO-${sale.businessDate.replaceAll("-","")}-${String(sale.saleIndex+1).padStart(3,"0")}`;
    const saleRow=await client.query(`INSERT INTO sales(id,organization_id,store_id,shift_id,seller_id,sale_number,client_reference,subtotal,discount_amount,total,returned_amount,customer,business_date,metadata,status,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$8,0,$9,$10,$11,'completed',$12) ON CONFLICT(id) DO UPDATE SET subtotal=EXCLUDED.subtotal,total=EXCLUDED.total,metadata=EXCLUDED.metadata,created_at=EXCLUDED.created_at
      WHERE sales.organization_id=EXCLUDED.organization_id AND sales.metadata->>'seedKey'=$13 RETURNING id`,[saleId,orgId,storeId,shiftId,userId,saleNumber,`${SEED_KEY}:${sale.key}`,sale.total,{},sale.businessDate,marker({paymentKind:sale.paymentKind}),sale.createdAt,SEED_KEY]);
    await assertOwnedUpsert(saleRow,`sale ${saleNumber}`);
    const aggregate=dayAggregates.get(sale.businessDate); aggregate.total+=sale.total; aggregate.count+=1; sale.payments.forEach(p=>aggregate[p.method]+=p.amount);
    for(let lineIndex=0;lineIndex<sale.items.length;lineIndex+=1){
      const item=sale.items[lineIndex], product=plan.catalog[item.productIndex], productId=stableUuid(orgId,`product:${product.index}`), before=running[product.index], after=before-item.quantity;
      if(after<0) throw new Error(`Generated negative stock for ${product.sku}`); running[product.index]=after;
      const itemId=stableUuid(orgId,`sale-item:${sale.key}:${lineIndex}`), movementId=stableUuid(orgId,`sale-movement:${sale.key}:${lineIndex}`);
      const tracking={batches:[{batchId:stableUuid(orgId,`batch:${product.index}`),batchNo:`ZM-${String(product.index+1).padStart(3,"0")}`,expiryDate:null,quantity:item.quantity,startOffset:0,endOffset:item.quantity}]};
      await client.query(`INSERT INTO sale_items(id,sale_id,product_id,product_name,sku,barcode,quantity,unit_price,discount_percent,line_total,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10) ON CONFLICT(id) DO UPDATE SET quantity=EXCLUDED.quantity,unit_price=EXCLUDED.unit_price,line_total=EXCLUDED.line_total,metadata=EXCLUDED.metadata`,[itemId,saleId,productId,product.name,product.sku,product.barcode,item.quantity,item.unitPrice,item.lineTotal,marker({costPrice:item.costPrice,tracking})]);
      await client.query(`INSERT INTO stock_movements(id,organization_id,store_id,product_id,type,quantity,before_quantity,after_quantity,unit_cost,reference_type,reference_id,reason,metadata,created_by,created_at)
        VALUES($1,$2,$3,$4,'sale',$5,$6,$7,$8,'sale',$9,'',$10,$11,$12) ON CONFLICT(id) DO UPDATE SET quantity=EXCLUDED.quantity,before_quantity=EXCLUDED.before_quantity,after_quantity=EXCLUDED.after_quantity,unit_cost=EXCLUDED.unit_cost,metadata=EXCLUDED.metadata,created_at=EXCLUDED.created_at
        WHERE stock_movements.organization_id=EXCLUDED.organization_id AND stock_movements.metadata->>'seedKey'=$13`,[movementId,orgId,storeId,productId,-item.quantity,before,after,item.costPrice,saleId,marker({tracking}),userId,sale.createdAt,SEED_KEY]);
    }
    for(let paymentIndex=0;paymentIndex<sale.payments.length;paymentIndex+=1){
      const payment=sale.payments[paymentIndex], paymentId=stableUuid(orgId,`sale-payment:${sale.key}:${paymentIndex}`);
      await client.query(`INSERT INTO sale_payments(id,sale_id,method,amount,metadata) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO UPDATE SET method=EXCLUDED.method,amount=EXCLUDED.amount,metadata=EXCLUDED.metadata`,[paymentId,saleId,payment.method,payment.amount,marker()]);
    }
  }

  for(const product of plan.catalog){
    const productId=stableUuid(orgId,`product:${product.index}`), qty=running[product.index], batchId=stableUuid(orgId,`batch:${product.index}`);
    await client.query(`INSERT INTO inventory_balances(organization_id,store_id,product_id,quantity,avg_cost,version,updated_at) VALUES($1,$2,$3,$4,$5,1,now())
      ON CONFLICT(store_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity,avg_cost=EXCLUDED.avg_cost,version=inventory_balances.version+1,updated_at=now()
      WHERE inventory_balances.organization_id=EXCLUDED.organization_id`,[orgId,storeId,productId,qty,product.costPrice]);
    await client.query(`INSERT INTO inventory_batches(id,organization_id,store_id,product_id,reference_id,batch_no,received_quantity,remaining_quantity,unit_cost,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET received_quantity=EXCLUDED.received_quantity,remaining_quantity=EXCLUDED.remaining_quantity,unit_cost=EXCLUDED.unit_cost`,[batchId,orgId,storeId,productId,`ZM-KIRIM-${product.index%3+1}`,`ZM-${String(product.index+1).padStart(3,"0")}`,product.received,qty,product.costPrice,receivedAt]);
  }

  for(const day of plan.days.slice(0,-1)){
    const a=dayAggregates.get(day.date), id=stableUuid(orgId,`business-day:${day.date}`);
    const existing=await client.query("SELECT metadata FROM business_days WHERE organization_id=$1 AND store_id=$2 AND business_date=$3 FOR UPDATE",[orgId,storeId,day.date]);
    if(existing.rowCount && existing.rows[0].metadata?.seedKey!==SEED_KEY) throw new Error(`Business day ${day.date} already contains non-seed data`);
    await client.query(`INSERT INTO business_days(id,organization_id,store_id,business_date,status,total,cash,card,transfer,sale_count,metadata,closed_by,closed_at)
      VALUES($1,$2,$3,$4,'closed',$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(organization_id,store_id,business_date) DO UPDATE SET total=EXCLUDED.total,cash=EXCLUDED.cash,card=EXCLUDED.card,transfer=EXCLUDED.transfer,sale_count=EXCLUDED.sale_count,metadata=EXCLUDED.metadata,closed_by=EXCLUDED.closed_by,closed_at=EXCLUDED.closed_at`,[id,orgId,storeId,day.date,a.total,a.cash,a.card,a.transfer,a.count,marker(),userId,`${day.date}T21:35:00+05:00`]);
  }

  const expenseTemplates=[["Elektr energiyasi","Kommunal",185000,"transfer"],["Yetkazib berish xizmati","Logistika",95000,"card"],["Tozalash vositalari","Xo‘jalik",72000,"card"],["Internet va aloqa","Aloqa",120000,"transfer"],["Mayda ta’mirlash","Ta’mir",85000,"card"],["Reklama materiallari","Marketing",140000,"transfer"],["Kuryer xizmati","Logistika",65000,"card"]];
  for(let i=0;i<plan.days.length;i+=1){
    const [title,category,amount,method]=expenseTemplates[i], id=stableUuid(orgId,`expense:${plan.days[i].date}`);
    await client.query(`INSERT INTO expenses(id,organization_id,store_id,shift_id,title,category,amount,payment_method,note,metadata,created_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Demo do‘kon operatsion xarajati',$9,$10,$11,$11) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,category=EXCLUDED.category,amount=EXCLUDED.amount,payment_method=EXCLUDED.payment_method,note=EXCLUDED.note,metadata=EXCLUDED.metadata,updated_at=EXCLUDED.updated_at
      WHERE expenses.organization_id=EXCLUDED.organization_id AND expenses.metadata->>'seedKey'=$12`,[id,orgId,storeId,shiftIds[i],title,category,amount,method,marker(),userId,`${plan.days[i].date}T14:20:00+05:00`,SEED_KEY]);
  }

  const auditId=stableUuid(orgId,`audit:${plan.days[6].date}`);
  await client.query(`INSERT INTO audit_logs(id,organization_id,user_id,store_id,action,entity_type,entity_id,title,description,after_data,metadata,created_at)
    VALUES($1,$2,$3,$4,'seed','demo_backfill',$5,'Demo ma’lumotlar tayyorlandi','100 mahsulot va 7 kunlik savdo tarixi',$6,$7,now())
    ON CONFLICT(id) DO UPDATE SET after_data=EXCLUDED.after_data,metadata=EXCLUDED.metadata,created_at=now()`,[auditId,orgId,userId,storeId,SEED_KEY,{products:100,sales:126,anchorDate:plan.days[6].date},marker()]);
  assertOperationalSafety(await operationalSafetySnapshot(client,{orgId,storeId,productIds,anchorDate:plan.days[6].date}));
}

async function main() {
  const {apply}=parseSeedMode(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const profile=await client.query(`SELECT u.id,u.organization_id,u.store_id,u.username,u.active,o.name organization_name
      FROM users u JOIN organizations o ON o.id=u.organization_id WHERE lower(u.username)=lower($1) FOR UPDATE OF u,o`,[EXPECTED_LOGIN]);
    const target=validateTargetProfile(profile.rows,EXPECTED_LOGIN,EXPECTED_ORGANIZATION);
    const anchorRow=(await client.query("SELECT after_data->>'anchorDate' anchor_date FROM audit_logs WHERE organization_id=$1 AND entity_type='demo_backfill' AND entity_id=$2 AND metadata->>'seedKey'=$2 ORDER BY created_at LIMIT 1",[target.organizationId,SEED_KEY])).rows[0];
    const today=(await client.query("SELECT (now() AT TIME ZONE 'Asia/Tashkent')::date::text AS date")).rows[0].date;
    const date=resolveAnchorDate(anchorRow?.anchor_date,today);
    const plan=buildDemoPlan(date);
    await seed(client,plan,target);
    const summary=await verify(client,{...target,plan});
    if(apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({mode:apply?"applied":"dry-run-rolled-back",target:{organizationId:target.organizationId,organizationName:target.organizationName,storeId:target.storeId},anchorDate:date,summary},null,2));
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{client.release();await pool.end();}
}

main().catch((error)=>{console.error(`[${SEED_KEY}] ${error.message}`);process.exitCode=1;});
