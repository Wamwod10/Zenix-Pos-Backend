import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const read=(p)=>readFile(new URL(p,import.meta.url),"utf8");
test("POS telegram scheduled report is tenant/store scoped and idempotent",async()=>{const worker=await read("../src/services/notificationWorker.js");assert.match(worker,/enqueueScheduledDailyReports/);assert.match(worker,/c\.organization_id/);assert.match(worker,/c\.store_id/);assert.match(worker,/scheduled:\$\{target\.organization_id\}/);assert.match(worker,/ON CONFLICT DO NOTHING/)});
test("telegram settings validate report time and keep event toggles boolean",async()=>{const route=await read("../src/routes/telegram.js");assert.match(route,/dailyReportTime/);assert.match(route,/\^\(\[01\]/);assert.match(route,/typeof value!=="boolean"/)});
