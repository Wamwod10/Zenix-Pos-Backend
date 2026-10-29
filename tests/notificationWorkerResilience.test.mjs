import test from "node:test";
import assert from "node:assert/strict";

test("scheduled report keeps the organization business date returned as a Date", async () => {
  const { normalizeScheduledBusinessDate } = await import("../src/services/notificationWorker.js");
  const postgresDate = new Date("2026-09-27T19:00:00.000Z");

  assert.equal(
    normalizeScheduledBusinessDate(postgresDate, "Asia/Tashkent"),
    "2026-09-28",
  );
});

test("a scheduled report failure does not reject the real-time notification cycle", async () => {
  const { runScheduledReportsSafely } = await import("../src/services/notificationWorker.js");
  const expectedError = new Error("invalid daily report date");
  let reportedError;

  await assert.doesNotReject(() => runScheduledReportsSafely(
    async () => { throw expectedError; },
    (error) => { reportedError = error; },
  ));
  assert.equal(reportedError, expectedError);
});

test("scheduled-report maintenance pause propagates to gate without retrying other events", async () => {
  const { runScheduledReportsSafely } = await import("../src/services/notificationWorker.js");
  await assert.rejects(() => runScheduledReportsSafely(
    async () => { throw new Error("financial writes paused during deployment"); },
    () => assert.fail("maintenance must go to worker gate, not ordinary reporting"),
  ), /financial writes paused/);
});
