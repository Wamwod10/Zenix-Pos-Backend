import test from "node:test";
import assert from "node:assert/strict";
import { databaseDateISO } from "../src/lib/businessDate.js";

test("PostgreSQL date values normalize to an ISO calendar date", () => {
  assert.equal(databaseDateISO(new Date(2026, 8, 24)), "2026-09-24");
  assert.equal(databaseDateISO("2026-09-24"), "2026-09-24");
  assert.equal(databaseDateISO("2026-09-24T19:00:00.000Z"), "2026-09-24");
});

test("invalid database dates fail with an actionable error", () => {
  assert.throws(() => databaseDateISO("not-a-date"), /database date/i);
});
