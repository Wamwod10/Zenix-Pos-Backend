import test from "node:test";
import assert from "node:assert/strict";
import { calculateDraft } from "../src/routes/billing.js";

test("extra-store drafts normalize PostgreSQL Date expiry values to ISO dates", async () => {
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (/FROM organizations/i.test(sql)) {
        return {
          rows: [{
            id: "org-1",
            plan: "ANNUAL",
            expiry_date: new Date("2027-09-29T00:00:00.000Z"),
            timezone: "Asia/Tashkent",
          }],
        };
      }
      if (/count\(\*\).*FROM stores/is.test(sql)) return { rows: [{ count: 2 }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const draft = await calculateDraft(client, { organizationId: "org-1" }, {
    type: "EXTRA",
    plan: "ANNUAL",
    intent: "EXTRA",
    extraStoreCount: 1,
    metadata: {},
  });

  assert.equal(draft.selectedEndDate, "2027-09-29");
  assert.match(draft.currentEndDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(queries.length, 2);
});
