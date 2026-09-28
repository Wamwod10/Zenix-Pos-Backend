import { pool } from "../db/pool.js";
import { formatNotification, sendTelegramMessage } from "./telegram.js";

let running=false;
const batchSize=20;

const notificationSettingKey=(eventType)=>({
  "sale.completed":"sale",
  "sale.returned":"returns",
  "shift.opened":"shiftClose",
  "shift.closed":"shiftClose",
  "inventory.received":"inventoryReceived",
  "inventory.transfer_dispatched":"transfers",
  "inventory.transfer_received":"transfers",
  "inventory.transfer_cancelled":"transfers",
  "inventory.low":"lowStock",
  "inventory.out":"outOfStock",
  "supplier.debt":"supplierDebt",
  "expense.created":"expenses",
  "daily.report":"dailyReport",
}[eventType]||null);

const enabledForEvent=(eventType,settings={})=>{
  const key=notificationSettingKey(eventType);
  return !key||settings?.[key]!==false;
};

export function normalizeScheduledBusinessDate(value,timezone="Asia/Tashkent"){
  if(typeof value==="string"&&/^\d{4}-\d{2}-\d{2}/.test(value))return value.slice(0,10);
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))throw new Error("Scheduled report business date is invalid");
  const parts=new Intl.DateTimeFormat("en",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const part=(type)=>parts.find((entry)=>entry.type===type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function claimEvents(){
  const {rows}=await pool.query(`
    WITH candidates AS (
      SELECT id
      FROM notification_outbox
      WHERE event_type <> 'billing.payment_review' AND ((
        status IN ('pending','retry') AND next_attempt_at<=now()
      ) OR (
        status='processing' AND next_attempt_at<=now()-interval '10 minutes'
      ))
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE notification_outbox n
    SET status='processing',next_attempt_at=now()
    FROM candidates c
    WHERE n.id=c.id
    RETURNING n.*`,[batchSize]);
  return rows;
}

async function prepareDeliveries(event){
  const connections=(await pool.query(`
    SELECT id,settings
    FROM telegram_connections
    WHERE organization_id=$1
      AND enabled=true
      AND (store_id IS NULL OR store_id=$2)
    ORDER BY linked_at`,[event.organization_id,event.store_id])).rows;
  const eligible=connections.filter((connection)=>enabledForEvent(event.event_type,connection.settings||{}));

  if(eligible.length){
    const values=[];
    const placeholders=[];
    eligible.forEach((connection,index)=>{
      const offset=index*2;
      placeholders.push(`($${offset+1},$${offset+2})`);
      values.push(event.id,connection.id);
    });
    await pool.query(`
      INSERT INTO notification_deliveries(outbox_id,connection_id)
      VALUES ${placeholders.join(",")}
      ON CONFLICT(outbox_id,connection_id) DO NOTHING`,values);
  }

  if(!eligible.length){
    await pool.query(`UPDATE notification_outbox
      SET status='sent',sent_at=COALESCE(sent_at,now()),last_error='',next_attempt_at=now()
      WHERE id=$1`,[event.id]);
    return;
  }
  await pool.query(`UPDATE notification_outbox
    SET status='delivering',last_error='',next_attempt_at=now()
    WHERE id=$1`,[event.id]);
}

async function claimDeliveries(){
  const {rows}=await pool.query(`
    WITH candidates AS (
      SELECT d.id
      FROM notification_deliveries d
      WHERE (
        d.status IN ('pending','retry') AND d.next_attempt_at<=now()
      ) OR (
        d.status='processing' AND d.next_attempt_at<=now()-interval '10 minutes'
      )
      ORDER BY d.created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE notification_deliveries d
    SET status='processing',updated_at=now(),next_attempt_at=now()
    FROM candidates c
    WHERE d.id=c.id
    RETURNING d.*`,[batchSize]);
  return rows;
}

async function deliveryContext(delivery){
  return (await pool.query(`
    SELECT d.id,d.outbox_id,d.attempts,
           n.event_type,n.payload,n.organization_id,n.store_id,
           c.organization_id AS connection_organization_id,
           c.store_id AS connection_store_id,
           c.chat_id,c.enabled,c.settings
    FROM notification_deliveries d
    JOIN notification_outbox n ON n.id=d.outbox_id
    JOIN telegram_connections c ON c.id=d.connection_id
    WHERE d.id=$1`,[delivery.id])).rows[0]||null;
}

async function finalizeOutbox(outboxId){
  const state=(await pool.query(`
    SELECT count(*)::int total,
      count(*) FILTER (WHERE status='sent')::int sent,
      count(*) FILTER (WHERE status='failed')::int failed,
      count(*) FILTER (WHERE status='cancelled')::int cancelled,
      count(*) FILTER (WHERE status IN ('pending','retry','processing'))::int active
    FROM notification_deliveries WHERE outbox_id=$1`,[outboxId])).rows[0];
  if(!state||Number(state.total||0)===0){
    await pool.query("UPDATE notification_outbox SET status='sent',sent_at=COALESCE(sent_at,now()) WHERE id=$1",[outboxId]);
    return;
  }
  if(Number(state.active||0)>0){
    await pool.query("UPDATE notification_outbox SET status='delivering' WHERE id=$1",[outboxId]);
    return;
  }
  if(Number(state.failed||0)>0){
    await pool.query(`UPDATE notification_outbox SET status='failed',last_error=$2 WHERE id=$1`,[outboxId,"Telegram guruhlaridan biriga xabar yetkazilmadi"]);
    return;
  }
  await pool.query(`UPDATE notification_outbox
    SET status='sent',sent_at=COALESCE(sent_at,now()),last_error=''
    WHERE id=$1`,[outboxId]);
}

async function markDeliverySent(deliveryId,outboxId){
  await pool.query(`UPDATE notification_deliveries
    SET status='sent',sent_at=now(),attempts=attempts+1,last_error='',next_attempt_at=now(),updated_at=now()
    WHERE id=$1 AND status='processing'`,[deliveryId]);
  await finalizeOutbox(outboxId);
}

async function markDeliveryCancelled(deliveryId,outboxId){
  await pool.query(`UPDATE notification_deliveries
    SET status='cancelled',last_error='',updated_at=now()
    WHERE id=$1`,[deliveryId]);
  await finalizeOutbox(outboxId);
}

async function markDeliveryFailed(deliveryId,outboxId,error){
  await pool.query(`UPDATE notification_deliveries
    SET status=CASE WHEN attempts+1>=8 THEN 'failed' ELSE 'retry' END,
        attempts=attempts+1,
        last_error=$2,
        next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(attempts,6))::int)),
        updated_at=now()
    WHERE id=$1`,[deliveryId,String(error?.message||error||"Telegram xatosi").slice(0,1000)]);
  await finalizeOutbox(outboxId);
}

async function deliver(delivery){
  const context=await deliveryContext(delivery);
  if(!context)return;
  const tenantMismatch=String(context.organization_id)!==String(context.connection_organization_id);
  const storeMismatch=context.connection_store_id&&String(context.store_id)!==String(context.connection_store_id);
  if(tenantMismatch||storeMismatch||!context.enabled||!enabledForEvent(context.event_type,context.settings||{})){
    await markDeliveryCancelled(delivery.id,context.outbox_id);
    return;
  }
  const text=formatNotification(context.event_type,context.payload||{});
  try{
    await sendTelegramMessage(context.chat_id,text);
    await markDeliverySent(delivery.id,context.outbox_id);
  }catch(error){
    await markDeliveryFailed(delivery.id,context.outbox_id,error);
  }
}


async function enqueueScheduledDailyReports(){
  const {rows:targets}=await pool.query(`
    SELECT DISTINCT c.organization_id,c.store_id,o.timezone,
      (now() AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent'))::date AS business_date
    FROM telegram_connections c
    JOIN organizations o ON o.id=c.organization_id
    WHERE c.enabled=true
      AND COALESCE((c.settings->>'dailyReport')::boolean,true)=true
      AND (now() AT TIME ZONE COALESCE(NULLIF(o.timezone,''),'Asia/Tashkent'))::time >= COALESCE(NULLIF(c.settings->>'dailyReportTime','')::time,time '21:00')`);
  for(const target of targets){
    const date=normalizeScheduledBusinessDate(target.business_date,target.timezone);
    const storeKey=target.store_id||'all';
    const eventId=`scheduled:${target.organization_id}:${storeKey}:${date}`;
    const exists=(await pool.query("SELECT 1 FROM notification_outbox WHERE event_type='daily.report' AND event_id=$1 LIMIT 1",[eventId])).rowCount>0;
    if(exists)continue;
    const params=[target.organization_id,date];
    const storeSql=target.store_id?` AND s.store_id=$3`:'';if(target.store_id)params.push(target.store_id);
    const summary=(await pool.query(`WITH scoped AS (
        SELECT s.id,s.total,s.returned_amount FROM sales s WHERE s.organization_id=$1 AND s.business_date=$2${storeSql}
      ), payment_totals AS (
        SELECT sp.method,sum(sp.amount)::numeric amount FROM sale_payments sp JOIN scoped s ON s.id=sp.sale_id GROUP BY sp.method
      )
      SELECT (SELECT count(*)::int FROM scoped) AS sale_count,
        COALESCE((SELECT sum(total-returned_amount) FROM scoped),0)::numeric AS total,
        COALESCE((SELECT amount FROM payment_totals WHERE method='cash'),0)::numeric AS cash,
        COALESCE((SELECT amount FROM payment_totals WHERE method='card'),0)::numeric AS card,
        COALESCE((SELECT amount FROM payment_totals WHERE method='transfer'),0)::numeric AS transfer` ,params)).rows[0];
    const storeName=target.store_id?(await pool.query("SELECT name FROM stores WHERE id=$1 AND organization_id=$2",[target.store_id,target.organization_id])).rows[0]?.name||'Filial':'Barcha filiallar';
    await pool.query(`INSERT INTO notification_outbox(organization_id,store_id,event_type,event_id,payload) VALUES($1,$2,'daily.report',$3,$4) ON CONFLICT DO NOTHING`,[target.organization_id,target.store_id,eventId,{businessDate:date,storeName,saleCount:Number(summary?.sale_count||0),total:Number(summary?.total||0),cash:Number(summary?.cash||0),card:Number(summary?.card||0),transfer:Number(summary?.transfer||0)}]);
  }
}

export async function runScheduledReportsSafely(run=enqueueScheduledDailyReports,onError=(error)=>console.error("[telegram-worker:daily-report]",error)){
  try{await run()}
  catch(error){onError(error)}
}

export async function processNotificationOutbox(){
  if(running)return;
  running=true;
  try{
    await runScheduledReportsSafely();
    const events=await claimEvents();
    for(const event of events){
      try{await prepareDeliveries(event)}
      catch(error){
        await pool.query(`UPDATE notification_outbox
          SET status='retry',attempts=attempts+1,last_error=$2,
              next_attempt_at=now()+interval '30 seconds'
          WHERE id=$1`,[event.id,String(error?.message||error||"Notification tayyorlash xatosi").slice(0,1000)]);
      }
    }
    const deliveries=await claimDeliveries();
    for(const delivery of deliveries)await deliver(delivery);
  }finally{running=false}
}

export function startNotificationWorker(){
  const timer=setInterval(()=>processNotificationOutbox().catch((error)=>console.error("[telegram-worker]",error)),15_000);
  timer.unref?.();
  processNotificationOutbox().catch((error)=>console.error("[telegram-worker]",error));
  return timer;
}
