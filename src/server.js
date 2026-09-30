import { app } from "./app.js";
import { assertServerEnvironment, env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { assertDatabaseConnection } from "./db/startup.js";
import { startNotificationWorker } from "./services/notificationWorker.js";
import { startPaymentNotificationWorker } from "./services/paymentNotificationWorker.js";
import { configureTelegramWebhook, configurePaymentTelegramWebhook } from "./services/telegramWebhook.js";

assertServerEnvironment();

try{
  const connection=await assertDatabaseConnection(pool);
  console.log(`[db] connected database=${connection.database} user=${connection.userName}`);
}catch(error){
  console.error(`[startup] ${error.message}`);
  await pool.end().catch(()=>{});
  process.exit(1);
}

const server=app.listen(env.port,()=>{
  console.log(`Zenix POS API listening on :${env.port}`);
  if(process.env.RUN_NOTIFICATION_WORKERS!=="false"){startNotificationWorker();startPaymentNotificationWorker();}
  configureTelegramWebhook()
    .then(({url})=>console.log(`[telegram] webhook configured: ${url}`))
    .catch((error)=>console.error(`[telegram] webhook configuration failed: ${error.message}`));
  configurePaymentTelegramWebhook()
    .then(({url})=>console.log(`[payment-telegram] webhook configured: ${url}`))
    .catch((error)=>console.error(`[payment-telegram] webhook configuration failed: ${error.message}`));
});
const shutdown=async()=>{server.close(async()=>{await pool.end().catch(()=>{});process.exit(0)});setTimeout(()=>process.exit(1),10_000).unref();};
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
