import { Router } from "express";
import { pool } from "../db/pool.js";
import { asyncRoute, ok } from "../lib/http.js";
import { requireAuth, requireOrganization } from "../middleware/auth.js";
import { isBranchLocked } from "../lib/storeScope.js";
import { canReadEmployees, hasPermission } from "../lib/permissions.js";
import { databaseDateISO, organizationCalendarDateISO } from "../lib/businessDate.js";
import { selectActiveBranchShifts } from "../lib/branchShift.js";
import { shiftSalesStats } from "../services/financeReport.js";

const router=Router();
const n=(value)=>Number(value||0);
const dateParts=(value,timeZone="Asia/Tashkent")=>{
  const date=value?new Date(value):new Date();
  const dateISO=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
  const dateText=new Intl.DateTimeFormat("uz-UZ",{timeZone,day:"2-digit",month:"2-digit",year:"numeric"}).format(date);
  const time=new Intl.DateTimeFormat("uz-UZ",{timeZone,hour:"2-digit",minute:"2-digit",hour12:false}).format(date);
  return {dateISO,date:dateText,time};
};
const mapProduct=(row)=>({
  ...(row.metadata||{}),
  id:row.id,name:row.name,sku:row.sku,barcode:row.barcode,category:row.category,brand:row.brand,unit:row.unit,
  costPrice:n(row.cost_price),sellPrice:n(row.sell_price),price:n(row.sell_price),wholesalePrice:n(row.wholesale_price),minStock:n(row.min_stock),archived:row.archived,
  stockByStore:row.stock_by_store||{},lastSaleAt:row.last_sale_at||null,metadata:row.metadata||{},
});
const statusTransfer=(status)=>({pending:"PENDING",approved:"PENDING",dispatched:"IN_TRANSIT",received:"RECEIVED",received_with_difference:"RECEIVED_WITH_DIFFERENCE",cancelled:"REJECTED"}[status]||String(status||"").toUpperCase());
const statusCount=(status)=>({review:"PENDING",applying:"PENDING",approved:"APPROVED",rejected:"REJECTED",conflict:"CONFLICT"}[status]||String(status||"").toUpperCase());

router.get("/",requireAuth,requireOrganization,asyncRoute(async(req,res)=>{
  const orgId=req.user.organizationId;
  const branchStoreId=isBranchLocked(req.user)?req.user.storeId:null;
  const orgResult=await pool.query(`SELECT *,CASE WHEN expiry_date IS NULL THEN true ELSE expiry_date >= (now() AT TIME ZONE COALESCE(NULLIF(timezone,''),'Asia/Tashkent'))::date END AS license_date_valid FROM organizations WHERE id=$1`,[orgId]);
  const org=orgResult.rows[0]||{};
  const businessDate=organizationCalendarDateISO(org);
  // Full-term branch passes are needed for accurate renewal pricing in the UI.
  // Never expose payment/receipt identifiers; the API recalculates all prices.
  const extraStoreEntitlements=org.id?(await pool.query(`SELECT quantity,starts_on,expires_on FROM extra_store_entitlements
    WHERE organization_id=$1
    ORDER BY expires_on ASC`,[orgId])).rows.map(row=>({
      quantity:Number(row.quantity),startsOn:databaseDateISO(row.starts_on),expiresOn:databaseDateISO(row.expires_on),
      status:databaseDateISO(row.starts_on)<=businessDate&&databaseDateISO(row.expires_on)>businessDate?'ACTIVE':'INACTIVE',
    })):[];
  const activeExtraStores=extraStoreEntitlements.filter(row=>row.status==='ACTIVE').reduce((sum,row)=>sum+row.quantity,0);
  const effectiveStoreLimit=Number(org.store_limit||0)+activeExtraStores;
  const licenseStatus=String(org.license_status||"PAYMENT_REQUIRED").toUpperCase();
  const licenseActive=(licenseStatus==="ACTIVE"||licenseStatus==="APPROVED")&&org.license_date_valid!==false&&!org.settings?.billingHold&&(!org.settings?.trialEndsAt||Date.parse(org.settings.trialEndsAt)>Date.now());
  if(!licenseActive){
    const [storesResult,billingResult]=await Promise.all([
      pool.query(`SELECT * FROM stores WHERE organization_id=$1${branchStoreId?" AND id=$2":""} ORDER BY created_at`,branchStoreId?[orgId,branchStoreId]:[orgId]),
      pool.query("SELECT * FROM billing_payments WHERE organization_id=$1 ORDER BY submitted_at DESC LIMIT 500",[orgId]),
    ]);
    const stores=storesResult.rows.map((row)=>({id:row.id,name:row.name,active:row.active,archivedAt:row.archived_at}));
    const payments=billingResult.rows.map((row)=>({id:row.id,orderId:row.order_id,organizationId:row.organization_id,organization:org.name||"",draftId:row.draft_id,type:row.type,plan:row.plan,amount:n(row.amount),status:row.status,servicePeriodFrom:row.service_period_from,servicePeriodTo:row.service_period_to,targetExpiry:row.service_period_to,extensionDays:Number(row.extension_days||0),extraStores:Number(row.extra_store_count||0),renewalExtraStores:Number(row.extra_store_count||0),purpose:row.type==="EXTRA"?`Qo‘shimcha filial limiti · ${Number(row.extra_store_count||0)} ta`:`${row.plan==="MONTHLY"?"Oylik":"Yillik"} tarif`,receiptId:row.receipt_id,receiptName:row.receipt_name,receiptType:row.receipt_type,rejectReason:row.reject_reason,submittedAt:row.submitted_at,reviewedAt:row.reviewed_at}));
    const billingVisible=hasPermission(req.user,"moduleBilling")||hasPermission(req.user,"billingWrite");
    return ok(res,{
      organization:{serverNow:new Date().toISOString(),id:org.id,name:org.name,phone:org.phone,address:org.address,timezone:org.timezone,currency:org.currency,plan:org.plan,licenseStatus:org.license_status,expiryDate:org.expiry_date,storeLimit:effectiveStoreLimit,baseStoreLimit:Number(org.store_limit||0),activeExtraStores,extraStoreEntitlements,settings:org.settings||{}},
      stores,inventory:[],dailySales:[],salesHistory:[],returns:[],suppliers:[],expenses:[],activeShifts:{},shiftHistory:[],activityLogs:[],inventoryTransfers:[],stockMovements:[],inventoryCounts:[],payments:billingVisible?payments:[],telegramConnections:[],employees:[],
    });
  }
  const timeZone=org.timezone||"Asia/Tashkent";
  const storeArg=branchStoreId?[orgId,branchStoreId]:[orgId];
  const storeFilter=(alias="")=>branchStoreId?` AND ${alias?`${alias}.`:""}store_id=$2`:"";

  const [storesResult,productsResult,salesResult,returnsResult,suppliersResult,invoicesResult,invoiceItemsResult,supplierPaymentsResult,expensesResult,shiftsResult,shiftMovementsResult,logsResult,movementsResult,transfersResult,countsResult,businessDaysResult,billingResult,telegramResult,usersResult,serialsResult,batchesResult]=await Promise.all([
    pool.query(`SELECT * FROM stores WHERE organization_id=$1${branchStoreId?" AND id=$2":""} ORDER BY created_at`,storeArg),
    pool.query(`SELECT p.*,
      COALESCE(jsonb_object_agg(ib.store_id,ib.quantity) FILTER (WHERE ib.store_id IS NOT NULL),'{}'::jsonb) AS stock_by_store,
      max(ls.last_sale_at) AS last_sale_at
      FROM products p
      LEFT JOIN inventory_balances ib ON ib.product_id=p.id AND ib.organization_id=p.organization_id ${branchStoreId?"AND ib.store_id=$2":""}
      LEFT JOIN (
        SELECT si.product_id,max(s.created_at) AS last_sale_at
        FROM sale_items si JOIN sales s ON s.id=si.sale_id
        WHERE s.organization_id=$1 ${branchStoreId?"AND s.store_id=$2":""}
        GROUP BY si.product_id
      ) ls ON ls.product_id=p.id
      WHERE p.organization_id=$1 GROUP BY p.id ORDER BY p.created_at`,storeArg),
    pool.query(`SELECT s.*,u.name seller_name,st.name store_name,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id',si.id,'productId',si.product_id,'name',si.product_name,'sku',si.sku,'barcode',si.barcode,'quantity',si.quantity,'qty',si.quantity,'finalPrice',si.unit_price*(1-si.discount_percent/100.0),'unitPrice',si.unit_price,'discountPercent',si.discount_percent,'lineTotal',si.line_total,'metadata',si.metadata,'unit',COALESCE(si.metadata->>'unit','dona'),'returnedQty',COALESCE(sr.returned_qty,0),'unitCost',COALESCE((SELECT sm.unit_cost FROM stock_movements sm WHERE sm.reference_type='sale' AND sm.reference_id=si.sale_id::text AND sm.product_id=si.product_id ORDER BY sm.created_at LIMIT 1),0))) FILTER (WHERE si.id IS NOT NULL),'[]'::jsonb) items,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('method',sp.method,'amount',sp.amount,'metadata',sp.metadata) ORDER BY sp.id) FROM sale_payments sp WHERE sp.sale_id=s.id),'[]'::jsonb) payments
      FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id LEFT JOIN (SELECT sale_id,product_id,sum(quantity) returned_qty FROM sale_returns WHERE organization_id=$1 GROUP BY sale_id,product_id) sr ON sr.sale_id=si.sale_id AND sr.product_id=si.product_id LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN stores st ON st.id=s.store_id
      WHERE s.organization_id=$1${storeFilter("s")} GROUP BY s.id,u.name,st.name ORDER BY s.created_at DESC LIMIT 3000`,storeArg),
    pool.query(`SELECT r.*,p.name product_name,s.sale_number,u.name created_by_name FROM sale_returns r JOIN products p ON p.id=r.product_id JOIN sales s ON s.id=r.sale_id LEFT JOIN users u ON u.id=r.created_by WHERE r.organization_id=$1${storeFilter("r")} ORDER BY r.created_at DESC LIMIT 3000`,storeArg),
    pool.query(`SELECT s.*,COALESCE((SELECT sum(greatest(i.total-i.paid_amount,0)) FROM supplier_invoices i WHERE i.supplier_id=s.id${branchStoreId?" AND i.store_id=$2":""}),0) debt FROM suppliers s WHERE s.organization_id=$1 ORDER BY s.created_at DESC`,storeArg),
    pool.query(`SELECT i.*,st.name store_name FROM supplier_invoices i LEFT JOIN stores st ON st.id=i.store_id WHERE i.organization_id=$1${storeFilter("i")} ORDER BY i.created_at DESC`,storeArg),
    pool.query(`SELECT sii.* FROM supplier_invoice_items sii JOIN supplier_invoices i ON i.id=sii.invoice_id WHERE i.organization_id=$1${storeFilter("i")}` ,storeArg),
    pool.query(`SELECT sp.*,st.name store_name FROM supplier_payments sp LEFT JOIN stores st ON st.id=sp.store_id WHERE sp.organization_id=$1${storeFilter("sp")} ORDER BY sp.created_at DESC`,storeArg),
    pool.query(`SELECT e.*,st.name store_name FROM expenses e LEFT JOIN stores st ON st.id=e.store_id WHERE e.organization_id=$1${storeFilter("e")} ORDER BY e.created_at DESC LIMIT 3000`,storeArg),
    pool.query(`SELECT sh.*,u.name cashier_name,st.name store_name FROM shifts sh LEFT JOIN users u ON u.id=sh.cashier_id LEFT JOIN stores st ON st.id=sh.store_id WHERE sh.organization_id=$1${storeFilter("sh")} ORDER BY sh.opened_at DESC LIMIT 1000`,storeArg),
    pool.query(`SELECT sm.* FROM shift_movements sm JOIN shifts sh ON sh.id=sm.shift_id WHERE sm.organization_id=$1${storeFilter("sh")} ORDER BY sm.created_at`,storeArg),
    pool.query(`SELECT a.*,u.name user_name,st.name store_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN stores st ON st.id=a.store_id WHERE a.organization_id=$1${branchStoreId?" AND (a.store_id IS NULL OR a.store_id=$2)":""} ORDER BY a.created_at DESC LIMIT 1500`,storeArg),
    pool.query(`SELECT sm.*,p.name product_name,u.name user_name,st.name store_name FROM stock_movements sm JOIN products p ON p.id=sm.product_id LEFT JOIN users u ON u.id=sm.created_by LEFT JOIN stores st ON st.id=sm.store_id WHERE sm.organization_id=$1${storeFilter("sm")} ORDER BY sm.created_at DESC LIMIT 3000`,storeArg),
    pool.query(`SELECT t.*,fs.name from_name,ts.name to_name,u.name created_by_name,
      COALESCE(jsonb_agg(jsonb_build_object('id',ti.id,'productId',ti.product_id,'product',p.name,'qty',ti.sent_quantity,'sentQty',ti.sent_quantity,'receivedQty',ti.received_quantity,'metadata',ti.metadata)) FILTER (WHERE ti.id IS NOT NULL),'[]'::jsonb) items
      FROM stock_transfers t LEFT JOIN stock_transfer_items ti ON ti.transfer_id=t.id LEFT JOIN products p ON p.id=ti.product_id LEFT JOIN stores fs ON fs.id=t.from_store_id LEFT JOIN stores ts ON ts.id=t.to_store_id LEFT JOIN users u ON u.id=t.created_by
      WHERE t.organization_id=$1${branchStoreId?" AND (t.from_store_id=$2 OR t.to_store_id=$2)":""} GROUP BY t.id,fs.name,ts.name,u.name ORDER BY t.created_at DESC`,storeArg),
    pool.query(`SELECT c.*,st.name store_name,u.name created_by_name,ru.name reviewed_by_name FROM inventory_counts c LEFT JOIN stores st ON st.id=c.store_id LEFT JOIN users u ON u.id=c.created_by LEFT JOIN users ru ON ru.id=c.reviewed_by WHERE c.organization_id=$1${storeFilter("c")} ORDER BY c.created_at DESC LIMIT 1000`,storeArg),
    pool.query(`SELECT bd.*,st.name store_name FROM business_days bd LEFT JOIN stores st ON st.id=bd.store_id WHERE bd.organization_id=$1${storeFilter("bd")} ORDER BY bd.business_date DESC LIMIT 1000`,storeArg),
    pool.query("SELECT * FROM billing_payments WHERE organization_id=$1 ORDER BY submitted_at DESC LIMIT 500",[orgId]),
    pool.query("SELECT * FROM telegram_connections WHERE organization_id=$1 AND enabled=true ORDER BY linked_at DESC",[orgId]),
    pool.query("SELECT id,organization_id,store_id,name,username,phone,app_role,permission_overrides,active,must_change_password,created_at FROM users WHERE organization_id=$1 ORDER BY created_at",[orgId]),
    pool.query(`SELECT ps.* FROM product_serials ps WHERE ps.organization_id=$1${storeFilter("ps")} ORDER BY ps.created_at`,storeArg),
    pool.query(`SELECT ib.* FROM inventory_batches ib WHERE ib.organization_id=$1${storeFilter("ib")} AND ib.remaining_quantity>0 ORDER BY ib.created_at`,storeArg),
  ]);

  const stores=storesResult.rows.map((row)=>({id:row.id,name:row.name,active:row.active,archivedAt:row.archived_at}));
  const storeName=new Map(stores.map((row)=>[row.id,row.name]));
  const serialsByProduct=new Map();for(const row of serialsResult.rows){const arr=serialsByProduct.get(row.product_id)||[];arr.push({id:row.id,serial:row.serial,storeId:row.store_id,status:row.status,receivedAt:row.created_at,saleId:row.sale_id,transferId:row.transfer_id||null});serialsByProduct.set(row.product_id,arr)}
  const batchesByProduct=new Map();for(const row of batchesResult.rows){const arr=batchesByProduct.get(row.product_id)||[];arr.push({id:row.id,storeId:row.store_id,receivedAt:row.created_at,invoiceNo:row.reference_id,batchNo:row.batch_no,expiryDate:row.expiry_date,quantity:n(row.received_quantity),remaining:n(row.remaining_quantity),costPrice:n(row.unit_cost)});batchesByProduct.set(row.product_id,arr)}
  const inventory=productsResult.rows.map((row)=>({...mapProduct(row),serializedUnits:serialsByProduct.get(row.id)||[],stockBatches:batchesByProduct.get(row.id)||[]}));

  const saleMap=(row)=>{
    const parts=dateParts(row.created_at,timeZone),payments=row.payments||[];
    const mix=payments.reduce((acc,p)=>{acc[p.method]=(acc[p.method]||0)+n(p.amount);return acc},{cash:0,card:0,transfer:0});
    const methods=Object.entries(mix).filter(([,value])=>value>0).map(([key])=>key);
    // Historical metadata must NEVER override database-authoritative amounts,
    // identifiers or refunded totals. Older sales may contain stale snapshots.
    return {...(row.metadata||{}),id:row.id,saleNumber:row.sale_number,clientReference:row.client_reference,storeId:row.store_id,store:row.store_name||storeName.get(row.store_id)||"",shiftId:row.shift_id||"",sellerId:row.seller_id||"",sellerAccountId:row.seller_id||"",sellerName:row.seller_name||"",seller:row.seller_name||"",subtotal:n(row.subtotal),discountTotal:n(row.discount_amount),total:n(row.total),saleTotal:n(row.total),returnedAmount:n(row.returned_amount),returnedTotal:n(row.returned_amount),customer:row.customer||{},items:(row.items||[]).map((item)=>({...(item.metadata||{}),...item,tracking:item.metadata?.tracking||null,returnedQty:n(item.returnedQty),unit:item.unit||item.metadata?.unit||"dona",unitCost:n(item.unitCost??item.metadata?.unitCost)})),payments,paymentBreakdown:methods.length>1?mix:null,paymentMethod:methods.length>1?"split":(methods[0]||"cash"),businessDateISO:databaseDateISO(row.business_date||parts.dateISO),dateISO:parts.dateISO,date:parts.date,time:parts.time,createdAt:row.created_at,status:row.status};
  };
  const sales=salesResult.rows.map(saleMap);
  const returns=returnsResult.rows.map((row)=>{const parts=dateParts(row.created_at,timeZone);return {...(row.metadata||{}),id:row.id,saleId:row.sale_id,storeId:row.store_id,productId:row.product_id,productName:row.product_name,quantity:n(row.quantity),amount:n(row.amount),reason:row.reason,refundMethod:row.refund_method,createdBy:row.created_by,actorName:row.created_by_name,businessDateISO:databaseDateISO(row.business_date||parts.dateISO),dateISO:parts.dateISO,date:parts.date,time:parts.time,createdAt:row.created_at}});
  const closedDayKeys=new Set(businessDaysResult.rows.map((row)=>`${row.store_id}:${databaseDateISO(row.business_date)}`));
  const dailySales=sales.filter((sale)=>!closedDayKeys.has(`${sale.storeId}:${sale.businessDateISO}`));
  const salesByDay=new Map();for(const sale of sales){const key=`${sale.storeId}:${sale.businessDateISO}`;const arr=salesByDay.get(key)||[];arr.push(sale);salesByDay.set(key,arr)}
  const salesHistory=businessDaysResult.rows.map((row)=>{const businessDateISO=databaseDateISO(row.business_date);return {id:row.id,storeId:row.store_id,store:row.store_name||storeName.get(row.store_id)||"",dateISO:businessDateISO,businessDateISO,date:dateParts(`${businessDateISO}T12:00:00Z`,timeZone).date,total:n(row.total),cash:n(row.cash),card:n(row.card),transfer:n(row.transfer),count:Number(row.sale_count||0),sales:salesByDay.get(`${row.store_id}:${businessDateISO}`)||[],closedAt:row.closed_at,metadata:row.metadata||{}}});

  const shiftMovementsById=new Map();for(const row of shiftMovementsResult.rows){const arr=shiftMovementsById.get(row.shift_id)||[];const parts=dateParts(row.created_at,timeZone);arr.push({id:row.id,type:row.type,amount:n(row.amount),reason:row.reason,source:row.source,referenceId:row.reference_id,time:parts.time,createdAt:row.created_at});shiftMovementsById.set(row.shift_id,arr)}
  // Gross capture belongs to the original shift. Cash refunds are recorded once
  // as out movements in the refund shift, never subtracted from captured sales.
  // Aggregate in PostgreSQL so the bootstrap detail limit cannot truncate cash.
  const saleStatsByShift=await shiftSalesStats(pool,orgId,branchStoreId);
  const mapShift=(row)=>{const moves=shiftMovementsById.get(row.id)||[],stats=saleStatsByShift.get(row.id)||{totalSales:0,cashSales:0,cardSales:0,transferSales:0};const opened=dateParts(row.opened_at,timeZone),closed=row.closed_at?dateParts(row.closed_at,timeZone):null;const cashIn=moves.filter(m=>m.type==="in").reduce((s,m)=>s+m.amount,0),cashOut=moves.filter(m=>m.type==="out").reduce((s,m)=>s+m.amount,0);return {...(row.metadata||{}),id:row.id,storeId:row.store_id,storeName:row.store_name||storeName.get(row.store_id)||"",cashierId:row.cashier_id,cashierAccountId:row.cashier_id,cashierName:row.cashier_name||"",registerKey:row.register_key,openingCash:n(row.opening_cash),expectedCash:n(row.expected_cash),actualCash:n(row.actual_cash),closingCash:n(row.actual_cash),difference:n(row.difference),openedAt:opened.time,openedAtISO:row.opened_at,closedAt:closed?.time||"",closedAtISO:row.closed_at,date:opened.date,dateISO:opened.dateISO,status:row.status,cashMovements:moves,cashIn,cashOut,...stats}};
  const shifts=shiftsResult.rows.map(mapShift);
  const activeShifts=selectActiveBranchShifts(shifts,{allowedStoreId:branchStoreId});
  const shiftHistory=shifts.filter((row)=>row.status!=="open");

  const invoiceItemsById=new Map();for(const row of invoiceItemsResult.rows){const arr=invoiceItemsById.get(row.invoice_id)||[];arr.push({id:row.id,productId:row.product_id,product:row.product_name,quantity:n(row.quantity),unitCost:n(row.unit_cost),total:n(row.total),...(row.metadata||{})});invoiceItemsById.set(row.invoice_id,arr)}
  const invoicesBySupplier=new Map();for(const row of invoicesResult.rows){const arr=invoicesBySupplier.get(row.supplier_id)||[];const parts=dateParts(row.created_at,timeZone),balance=Math.max(0,n(row.total)-n(row.paid_amount));const items=invoiceItemsById.get(row.id)||[];arr.push({id:row.id,invoiceNo:row.invoice_no,total:n(row.total),paidAmount:n(row.paid_amount),balance,paymentStatus:balance<=0?"paid":n(row.paid_amount)>0?"partial":"credit",dueDate:row.due_date||"",note:row.note||"",date:parts.date,dateISO:parts.dateISO,storeId:row.store_id||"",storeName:row.store_name||"",items,product:items.length===1?items[0].product:`${items.length} ta mahsulot`,productId:items.length===1?items[0].productId:"",quantity:items.reduce((s,i)=>s+i.quantity,0),...(row.metadata||{})});invoicesBySupplier.set(row.supplier_id,arr)}
  const paymentsBySupplier=new Map();for(const row of supplierPaymentsResult.rows){const arr=paymentsBySupplier.get(row.supplier_id)||[];const parts=dateParts(row.created_at,timeZone);arr.push({id:row.id,type:"payment",invoiceId:row.invoice_id||"",amount:n(row.amount),method:row.method,note:row.note,date:parts.date,dateISO:parts.dateISO,storeId:row.store_id||"",storeName:row.store_name||"",...(row.metadata||{})});paymentsBySupplier.set(row.supplier_id,arr)}
  const suppliers=suppliersResult.rows.map((row)=>{const purchaseHistory=invoicesBySupplier.get(row.id)||[],transactions=[...purchaseHistory.map(inv=>({id:`purchase:${inv.id}`,type:"purchase",invoiceId:inv.id,amount:inv.total,paidAmount:inv.paidAmount,balance:inv.balance,invoiceNo:inv.invoiceNo,items:inv.items,date:inv.date,dateISO:inv.dateISO,storeId:inv.storeId,storeName:inv.storeName,note:inv.note})),...(paymentsBySupplier.get(row.id)||[])].sort((a,b)=>String(b.dateISO).localeCompare(String(a.dateISO)));const deadline=purchaseHistory.filter(inv=>inv.balance>0&&inv.dueDate).map(inv=>String(inv.dueDate)).sort()[0]||"";return {id:row.id,name:row.name,phone:row.phone,contact:row.contact_name,telegram:row.telegram,archived:row.archived,debt:n(row.debt),paid:(paymentsBySupplier.get(row.id)||[]).reduce((s,p)=>s+p.amount,0),deadline:row.metadata?.deadline||deadline,notes:row.metadata?.notes||"",metadata:row.metadata||{},purchaseHistory,transactions}});

  const expenses=expensesResult.rows.map((row)=>{const parts=dateParts(row.created_at,timeZone);return {id:row.id,storeId:row.store_id,store:row.store_name||"",shiftId:row.shift_id||"",title:row.title,category:row.category,amount:n(row.amount),paymentMethod:row.payment_method,note:row.note,dateISO:parts.dateISO,date:parts.date,createdAt:row.created_at,...(row.metadata||{})}});
  const activityLogs=logsResult.rows.map((row)=>{const parts=dateParts(row.created_at,timeZone);return {id:row.id,type:row.action==="return"?"return":row.entity_type,title:row.title,description:row.description,userName:row.user_name||"",storeId:row.store_id||"",storeName:row.store_name||"",dateISO:parts.dateISO,date:parts.date,time:parts.time,createdAt:row.created_at,before:row.before_data,after:row.after_data,metadata:row.metadata||{}}});
  const stockMovements=movementsResult.rows.map((row)=>{const parts=dateParts(row.created_at,timeZone);const typeLabels={receive:"Kirim",adjust:n(row.quantity)>=0?"Qo‘shish":"Ayirish",sale:"Savdo",return:"Qaytarish",transfer_out:"Transfer chiqimi",transfer_in:"Transfer kirimi",transfer_cancel:"Transfer qaytimi",count:"Inventarizatsiya"};return {id:row.id,storeId:row.store_id,storeName:row.store_name||"",user:row.user_name||"",createdAt:row.created_at,date:`${parts.date} · ${parts.time}`,dateISO:parts.dateISO,productId:row.product_id,product:row.product_name,type:typeLabels[row.type]||row.type,qty:Math.abs(n(row.quantity)),before:n(row.before_quantity),after:n(row.after_quantity),reason:row.reason,metadata:row.metadata||{}}});
  const inventoryTransfers=transfersResult.rows.map((row)=>({id:row.id,fromStoreId:row.from_store_id,toStoreId:row.to_store_id,from:row.from_name||"",to:row.to_name||"",items:(row.items||[]).map(i=>({...i,qty:n(i.qty),sentQty:n(i.sentQty),receivedQty:i.receivedQty==null?null:n(i.receivedQty)})),itemCount:(row.items||[]).length,totalQty:(row.items||[]).reduce((s,i)=>s+n(i.sentQty),0),status:statusTransfer(row.status),differenceReason:row.difference_reason||"",createdBy:row.created_by_name||"",createdAt:row.created_at,sentAt:row.dispatched_at,receivedAt:row.received_at,updatedAt:row.updated_at}));
  const inventoryCounts=countsResult.rows.map((row)=>({id:row.id,storeId:row.store_id,storeName:row.store_name||"",changes:Array.isArray(row.snapshot)?row.snapshot:[],status:statusCount(row.status),createdBy:row.created_by_name||"",createdAt:row.created_at,approvedAt:row.reviewed_at,approvedBy:row.reviewed_by_name||"",conflicts:Array.isArray(row.result?.conflicts)?row.result.conflicts:[]}));
  const payments=billingResult.rows.map((row)=>({id:row.id,orderId:row.order_id,organizationId:row.organization_id,organization:org.name||"",draftId:row.draft_id,type:row.type,plan:row.plan,amount:n(row.amount),status:row.status,servicePeriodFrom:row.service_period_from,servicePeriodTo:row.service_period_to,targetExpiry:row.service_period_to,extensionDays:Number(row.extension_days||0),extraStores:Number(row.extra_store_count||0),renewalExtraStores:Number(row.extra_store_count||0),purpose:row.type==="EXTRA"?`Qo‘shimcha filial limiti · ${Number(row.extra_store_count||0)} ta`:`${row.plan==="MONTHLY"?"Oylik":"Yillik"} tarif`,receiptId:row.receipt_id,receiptName:row.receipt_name,receiptType:row.receipt_type,rejectReason:row.reject_reason,submittedAt:row.submitted_at,reviewedAt:row.reviewed_at}));

  const can=(permission)=>hasPermission(req.user,permission);
  const salesVisible=can("moduleSales")||can("moduleHistory")||can("moduleDashboard")||can("moduleAnalytics")||can("moduleSellerAnalytics")||can("moduleShifts");
  const inventoryVisible=can("moduleInventory")||can("moduleProducts")||can("moduleSales")||can("moduleDashboard")||can("moduleAnalytics");
  const supplierVisible=can("moduleSuppliers")||can("moduleInventory")||can("moduleDashboard");
  const expenseVisible=can("moduleExpenses")||can("moduleDashboard")||can("moduleAnalytics");
  const shiftVisible=can("moduleShifts")||can("moduleSales")||can("moduleSellerAnalytics");
  const settingsVisible=can("moduleSettings")||can("settingsWrite");
  const employeeVisible=canReadEmployees(req.user);
  const activityVisible=can("moduleActivityLog")||settingsVisible;
  const billingVisible=can("moduleBilling")||can("billingWrite");

  ok(res,{
    organization:{serverNow:new Date().toISOString(),id:org.id,name:org.name,phone:org.phone,address:org.address,timezone:org.timezone,currency:org.currency,plan:org.plan,licenseStatus:org.license_status,expiryDate:org.expiry_date,storeLimit:effectiveStoreLimit,baseStoreLimit:Number(org.store_limit||0),activeExtraStores,extraStoreEntitlements,settings:org.settings||{}},
    stores,
    inventory:inventoryVisible?inventory:[],
    dailySales:salesVisible?dailySales:[],salesHistory:salesVisible?salesHistory:[],returns:salesVisible?returns:[],
    suppliers:supplierVisible?suppliers:[],expenses:expenseVisible?expenses:[],
    activeShifts:shiftVisible?activeShifts:{},shiftHistory:shiftVisible?shiftHistory:[],
    activityLogs:activityVisible?activityLogs:[],
    inventoryTransfers:can("moduleInventory")?inventoryTransfers:[],stockMovements:inventoryVisible?stockMovements:[],inventoryCounts:can("moduleInventory")?inventoryCounts:[],
    payments:billingVisible?payments:[],
    telegramConnections:settingsVisible?telegramResult.rows:[],employees:employeeVisible?usersResult.rows:[],
  });
}));

export default router;
