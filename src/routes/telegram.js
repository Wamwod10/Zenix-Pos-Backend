import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { env } from "../config/env.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { isBranchLocked, scopedStoreId } from "../lib/storeScope.js";
import { sendTelegramMessage } from "../services/telegram.js";

const router=Router();
const protectedRouter=Router();protectedRouter.use(requireAuth,requireOrganization,requireActiveLicense);
const TELEGRAM_SETTING_KEYS=new Set(["sale","dailyReport","shiftClose","returns","expenses","transfers","inventoryReceived","lowStock","outOfStock","supplierDebt"]);
const escapeHtml=(value)=>String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const connectionScope=(req)=>isBranchLocked(req.user)?scopedStoreId(req.user,null):null;
const connectionScopeSql=(req,paramIndex)=>isBranchLocked(req.user)?` AND store_id=$${paramIndex}`:"";
const connectionScopeParams=(req)=>isBranchLocked(req.user)?[connectionScope(req)]:[];

protectedRouter.get("/connections",requirePermission("moduleSettings"),asyncRoute(async(req,res)=>{
  const scopeParams=connectionScopeParams(req);
  const {rows}=await pool.query(`SELECT * FROM telegram_connections WHERE organization_id=$1 AND enabled=true${connectionScopeSql(req,2)} ORDER BY linked_at DESC`,[req.user.organizationId,...scopeParams]);
  ok(res,{connections:rows});
}));
protectedRouter.post("/link",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const input=z.object({storeId:z.string().uuid().optional().nullable()}).parse(req.body||{});
  const effectiveStoreId=scopedStoreId(req.user,input.storeId||null);
  if(effectiveStoreId){
    const store=await pool.query("SELECT 1 FROM stores WHERE id=$1 AND organization_id=$2 AND active=true",[effectiveStoreId,req.user.organizationId]);
    if(!store.rowCount)throw new HttpError(404,"Faol filial topilmadi","STORE_NOT_FOUND");
  }
  const raw=randomToken(18);
  await withTransaction(async(client)=>{
    // A user should never have several valid group-link URLs at once. Invalidating
    // the previous one makes accidental sharing/reuse deterministic and safe.
    await client.query("UPDATE telegram_link_tokens SET consumed_at=now() WHERE organization_id=$1 AND created_by=$2 AND consumed_at IS NULL",[req.user.organizationId,req.user.id]);
    await client.query(`INSERT INTO telegram_link_tokens(organization_id,store_id,created_by,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')`,[req.user.organizationId,effectiveStoreId,req.user.id,sha256(raw)]);
  });
  const deepLink=`https://t.me/${env.telegramBotUsername}?startgroup=${encodeURIComponent(raw)}`;
  ok(res,{deepLink,expiresInSeconds:900,botUsername:`@${env.telegramBotUsername}`},201);
}));
protectedRouter.post("/connections/:id/disconnect",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const params=[req.params.id,req.user.organizationId,...connectionScopeParams(req)];
  const row=(await pool.query(`UPDATE telegram_connections SET enabled=false WHERE id=$1 AND organization_id=$2${connectionScopeSql(req,3)} RETURNING *`,params)).rows[0];
  if(!row)throw new HttpError(404,"Telegram guruh topilmadi");
  ok(res,{connection:row});
}));
protectedRouter.patch("/connections/:id/settings",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const input=z.object({settings:z.record(z.string(),z.boolean())}).parse(req.body||{});
  const invalid=Object.keys(input.settings).filter((key)=>!TELEGRAM_SETTING_KEYS.has(key));
  if(invalid.length)throw new HttpError(400,"Noma’lum Telegram bildirishnoma sozlamasi","INVALID_TELEGRAM_SETTING",{keys:invalid});
  const scopeParams=connectionScopeParams(req);
  const settingsIndex=3+scopeParams.length;
  const params=[req.params.id,req.user.organizationId,...scopeParams,JSON.stringify(input.settings)];
  const row=(await pool.query(`UPDATE telegram_connections SET settings=COALESCE(settings,'{}'::jsonb)||$${settingsIndex}::jsonb WHERE id=$1 AND organization_id=$2 AND enabled=true${connectionScopeSql(req,3)} RETURNING *`,params)).rows[0];
  if(!row)throw new HttpError(404,"Telegram guruh topilmadi");
  ok(res,{connection:row});
}));
protectedRouter.post("/connections/:id/test",requirePermission("settingsWrite"),asyncRoute(async(req,res)=>{
  const params=[req.params.id,req.user.organizationId,...connectionScopeParams(req)];
  const row=(await pool.query(`SELECT * FROM telegram_connections WHERE id=$1 AND organization_id=$2 AND enabled=true${connectionScopeSql(req,3)}`,params)).rows[0];
  if(!row)throw new HttpError(404,"Telegram guruh topilmadi");
  await sendTelegramMessage(row.chat_id,"✅ <b>Zenix POS ulandi</b>\n\nTest bildirishnomasi muvaffaqiyatli yuborildi.");
  ok(res,{sent:true});
}));
router.post("/webhook",asyncRoute(async(req,res)=>{
  if(env.telegramWebhookSecret){const secret=req.get("x-telegram-bot-api-secret-token");if(secret!==env.telegramWebhookSecret)throw new HttpError(403,"Webhook secret noto‘g‘ri","BAD_WEBHOOK_SECRET");}

  // Telegram reports when the bot is removed from a group. Disable the connection
  // immediately so the notification worker does not keep retrying a dead chat.
  const membership=req.body?.my_chat_member;
  if(membership?.chat?.id){
    const status=String(membership?.new_chat_member?.status||"");
    if(["left","kicked"].includes(status)){
      await pool.query("UPDATE telegram_connections SET enabled=false WHERE chat_id=$1",[String(membership.chat.id)]);
    }else if(["member","administrator"].includes(status)){
      await pool.query("UPDATE telegram_connections SET chat_title=$2 WHERE chat_id=$1",[String(membership.chat.id),membership.chat.title||"Telegram guruhi"]);
    }
    return ok(res,{accepted:true});
  }

  const message=req.body?.message||req.body?.edited_message;const chat=message?.chat;const text=String(message?.text||"").trim();
  if(!message||!chat)return ok(res,{accepted:true});

  // Telegram changes a group's chat_id when a basic group is upgraded to a
  // supergroup. Keep the same Zenix connection id so its settings and delivery
  // ledger remain intact instead of silently losing future notifications.
  if(message.migrate_to_chat_id){
    const oldChatId=String(chat.id);
    const newChatId=String(message.migrate_to_chat_id);
    await withTransaction(async(client)=>{
      const oldConnection=(await client.query("SELECT * FROM telegram_connections WHERE chat_id=$1 FOR UPDATE",[oldChatId])).rows[0];
      if(!oldConnection)return;
      const targetConnection=(await client.query("SELECT * FROM telegram_connections WHERE chat_id=$1 FOR UPDATE",[newChatId])).rows[0];
      if(targetConnection&&String(targetConnection.id)!==String(oldConnection.id)){
        // Never merge two independently linked tenants/connections implicitly.
        // Disable the obsolete chat and cancel only its unsent deliveries; the
        // already-authorized target connection remains the source of truth.
        await client.query("UPDATE telegram_connections SET enabled=false WHERE id=$1",[oldConnection.id]);
        await client.query(`UPDATE notification_deliveries SET status='cancelled',last_error='telegram chat migrated to an existing connection',updated_at=now()
          WHERE connection_id=$1 AND status IN ('pending','retry','processing')`,[oldConnection.id]);
        return;
      }
      await client.query("UPDATE telegram_connections SET chat_id=$2,chat_title=$3,enabled=true WHERE id=$1",[oldConnection.id,newChatId,chat.title||oldConnection.chat_title||"Telegram guruhi"]);
    });
    return ok(res,{accepted:true});
  }
  const start=text.match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);const token=start?.[1]?.trim();
  if(start&&["group","supergroup"].includes(chat.type)&&token){
    const linked=await withTransaction(async(client)=>{
      const tokenHash=sha256(token);
      const link=(await client.query("SELECT * FROM telegram_link_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE",[tokenHash])).rows[0];
      if(!link)return null;
      const chatId=String(chat.id);
      const previous=(await client.query("SELECT * FROM telegram_connections WHERE chat_id=$1 FOR UPDATE",[chatId])).rows[0];
      if(previous&&String(previous.organization_id)!==String(link.organization_id)){
        // A group can be deliberately moved to another Zenix organization by a group
        // administrator, but old queued deliveries must never cross the tenant boundary.
        await client.query(`UPDATE notification_deliveries SET status='cancelled',last_error='connection relinked',updated_at=now()
          WHERE connection_id=$1 AND status IN ('pending','retry','processing')`,[previous.id]);
      }
      const existing=(await client.query(`INSERT INTO telegram_connections(organization_id,store_id,chat_id,chat_title,linked_by,enabled)
        VALUES($1,$2,$3,$4,$5,true)
        ON CONFLICT(chat_id) DO UPDATE SET
          organization_id=EXCLUDED.organization_id,
          store_id=EXCLUDED.store_id,
          chat_title=EXCLUDED.chat_title,
          linked_by=EXCLUDED.linked_by,
          enabled=true,
          settings=CASE WHEN telegram_connections.organization_id=EXCLUDED.organization_id THEN telegram_connections.settings ELSE '{}'::jsonb END,
          linked_at=now()
        RETURNING *`,[link.organization_id,link.store_id||null,chatId,chat.title||"Telegram guruhi",link.created_by])).rows[0];
      await client.query("UPDATE telegram_link_tokens SET consumed_at=now() WHERE id=$1",[link.id]);
      return existing;
    });
    if(linked)await sendTelegramMessage(chat.id,`✅ <b>Zenix POS muvaffaqiyatli ulandi</b>\n\nGuruh: <b>${escapeHtml(chat.title||"Telegram guruhi")}</b>\nEndi Zenix POS bildirishnomalari shu guruhga keladi.`);else await sendTelegramMessage(chat.id,"⚠️ Ulanish havolasi eskirgan yoki allaqachon ishlatilgan. Zenix POS ichidan yangi ulash havolasini oching.");
    return ok(res,{accepted:true});
  }
  if(start&&chat.type==="private")await sendTelegramMessage(chat.id,`<b>Zenix POS</b>\n\nGuruh ulash uchun Zenix POS → Sozlamalar → Telegram bo‘limidagi “Guruhni ulash” tugmasidan foydalaning.`);
  return ok(res,{accepted:true});
}));

// Keep Telegram's public webhook outside browser/user session middleware.
router.use(protectedRouter);
export default router;
