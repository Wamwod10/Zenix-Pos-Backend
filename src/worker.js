import { assertServerEnvironment } from "./config/env.js";
import { pool } from "./db/pool.js";
import { assertDatabaseConnection } from "./db/startup.js";
import { createShutdownController } from "./shutdown.js";
import { startNotificationWorker } from "./services/notificationWorker.js";
import { startPaymentNotificationWorker } from "./services/paymentNotificationWorker.js";

assertServerEnvironment();
await assertDatabaseConnection(pool);
const workers = [startNotificationWorker(), startPaymentNotificationWorker()];
console.log("Zenix notification workers started");

const { shutdown } = createShutdownController({
  pool,
  stoppers: [() => Promise.all(workers.map((handle) => handle.stop()))],
});
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
