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

export async function processNotificationOutbox(){
  if(running)return;
  running=true;
  try{
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
