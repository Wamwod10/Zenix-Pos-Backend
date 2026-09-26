import { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { enqueueNotification } from "../services/notifications.js";
import { writeAudit } from "../services/audit.js";
import { assertOrganizationStore, assertStoreScope } from "../lib/storeScope.js";
import { hasPermission } from "../lib/permissions.js";
import { assertShiftCashAvailable, shiftExpectedCash } from "../lib/shiftCash.js";

const router = Router();
router.use(requireAuth, requireOrganization);
router.use(requireActiveLicense);

function assertShiftControl(user, shift) {
  if (hasPermission(user, "shiftRecon")) return;
  if (String(shift.cashier_id) !== String(user.id)) {
    throw new HttpError(403, "Boshqa kassir smenasini boshqarishga ruxsat yo‘q", "SHIFT_FORBIDDEN");
  }
}

router.post("/open", requirePermission("moduleShifts"), asyncRoute(async (req, res) => {
  const input = z.object({
    storeId: z.string().uuid(),
    openingCash: z.coerce.number().min(0).default(0),
    registerKey: z.string().trim().max(80).optional(),
    metadata: z.record(z.string(), z.any()).default({}),
  }).parse(req.body);
  assertStoreScope(req.user, input.storeId);

  const shift = await withTransaction(async (client) => {
    const store = await assertOrganizationStore(client, req.user.organizationId, input.storeId);
    // One register per account by default. This allows several cashiers to work in
    // the same branch at the same time without sharing or hijacking a shift.
    const registerKey = input.registerKey || `user:${req.user.id}`;
    const existing = await client.query(
      "SELECT 1 FROM shifts WHERE organization_id=$1 AND store_id=$2 AND register_key=$3 AND status='open' LIMIT 1",
      [req.user.organizationId, input.storeId, registerKey],
    );
    if (existing.rowCount) throw new HttpError(409, "Bu kassada smena allaqachon ochiq", "SHIFT_ALREADY_OPEN");

    const row = (await client.query(`
      INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,opening_cash,metadata)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [
      req.user.organizationId, input.storeId, req.user.id, registerKey, input.openingCash, input.metadata,
    ])).rows[0];

    await writeAudit(client, {
      organizationId: req.user.organizationId,
      userId: req.user.id,
      storeId: input.storeId,
      action: "open",
      entityType: "shift",
      entityId: row.id,
      title: "Smena ochildi",
      description: `${req.user.name} · ${store.name}`,
      after: { registerKey: row.register_key, openingCash: Number(row.opening_cash || 0), status: row.status },
    });
    await enqueueNotification(client, {
      organizationId: req.user.organizationId,
      storeId: input.storeId,
      eventType: "shift.opened",
      eventId: row.id,
      payload: { shiftId: row.id, cashierId: req.user.id, cashierName: req.user.name, storeName: store.name, openingCash: input.openingCash },
    });
    return row;
  });

  ok(res, { shift }, 201);
}));

router.post("/:id/movements", requirePermission("moduleShifts"), asyncRoute(async (req, res) => {
  const input = z.object({
    type: z.enum(["in", "out"]),
    amount: z.coerce.number().positive(),
    reason: z.string().trim().min(2).max(300),
    referenceId: z.string().max(120).default(""),
  }).parse(req.body);

  const movement = await withTransaction(async (client) => {
    const shift = (await client.query(
      "SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND status='open' FOR UPDATE",
      [req.params.id, req.user.organizationId],
    )).rows[0];
    if (!shift) throw new HttpError(404, "Ochiq smena topilmadi");
    assertStoreScope(req.user, shift.store_id);
    assertShiftControl(req.user, shift);
    if(input.type==="out")await assertShiftCashAvailable(client,shift,input.amount);

    const row = (await client.query(`
      INSERT INTO shift_movements(organization_id,shift_id,type,amount,reason,source,reference_id,created_by)
      VALUES($1,$2,$3,$4,$5,'manual',$6,$7) RETURNING *`, [
      req.user.organizationId, shift.id, input.type, input.amount, input.reason, input.referenceId, req.user.id,
    ])).rows[0];

    await writeAudit(client, {
      organizationId: req.user.organizationId,
      userId: req.user.id,
      storeId: shift.store_id,
      action: input.type === "in" ? "cash_in" : "cash_out",
      entityType: "shift",
      entityId: shift.id,
      title: input.type === "in" ? "Kassa kirimi" : "Kassa chiqimi",
      description: `${input.reason} · ${input.amount}`,
      after: { movementId: row.id, type: row.type, amount: Number(row.amount), reason: row.reason },
    });
    return row;
  });

  ok(res, { movement }, 201);
}));

router.post("/:id/close", requirePermission("moduleShifts"), asyncRoute(async (req, res) => {
  const input = z.object({
    actualCash: z.coerce.number().min(0),
    metadata: z.record(z.string(), z.any()).default({}),
  }).parse(req.body);

  const shift = await withTransaction(async (client) => {
    const current = (await client.query(
      "SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND status='open' FOR UPDATE",
      [req.params.id, req.user.organizationId],
    )).rows[0];
    if (!current) throw new HttpError(404, "Ochiq smena topilmadi");
    assertStoreScope(req.user, current.store_id);
    assertShiftControl(req.user, current);

    const expectedCash = await shiftExpectedCash(client,current);
    const difference = input.actualCash - expectedCash;
    const closed = (await client.query(`
      UPDATE shifts
      SET status='closed',expected_cash=$2,actual_cash=$3,difference=$4,metadata=metadata||$5::jsonb,closed_at=now()
      WHERE id=$1 RETURNING *`, [current.id, expectedCash, input.actualCash, difference, JSON.stringify(input.metadata)])).rows[0];

    const store = await assertOrganizationStore(client, req.user.organizationId, current.store_id);
    const cashier = (await client.query("SELECT name FROM users WHERE id=$1 AND organization_id=$2", [current.cashier_id, req.user.organizationId])).rows[0];
    const cashierName = cashier?.name || req.user.name;

    await writeAudit(client, {
      organizationId: req.user.organizationId,
      userId: req.user.id,
      storeId: current.store_id,
      action: "close",
      entityType: "shift",
      entityId: current.id,
      title: "Smena yopildi",
      description: `${cashierName} · farq ${difference}`,
      before: { status: current.status, openingCash: Number(current.opening_cash || 0) },
      after: { status: closed.status, expectedCash, actualCash: input.actualCash, difference },
    });
    await enqueueNotification(client, {
      organizationId: req.user.organizationId,
      storeId: current.store_id,
      eventType: "shift.closed",
      eventId: current.id,
      payload: { shiftId: current.id, storeName: store.name, cashierName, expectedCash, actualCash: input.actualCash, difference },
    });
    return closed;
  });

  ok(res, { shift });
}));

export default router;
