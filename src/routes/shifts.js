import { sumMoney, isMoneyInput, isSignedMoneyInput } from "../lib/posMoney.js";
import {resolveShiftRegister} from '../services/posRegisters.js';
import { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { enqueueNotification } from "../services/notifications.js";
import { writeAudit } from "../services/audit.js";
import { assertOrganizationStore, assertStoreScope } from "../lib/storeScope.js";
import { lockStoreTradingAuthorization } from "../services/storeTradingHolds.js";
import { hasPermission } from "../lib/permissions.js";
import { assertShiftCashAvailable, shiftExpectedCash, shiftCashSummary } from "../lib/shiftCash.js";
import { assertEmployeeShiftAvailableWithLock, findOpenBranchShiftWithLock } from "../lib/branchShift.js";

// Validate the exact two-decimal amount BEFORE coercion. z.coerce.number()
 // silently turns an empty string or null into 0; PostgreSQL NUMERIC(18,2)
 // silently rounds fractions of a tiyin. Both are unsafe at shift close.
const shiftMoneySchema = z.union([z.string(),z.number()])
  .refine(isMoneyInput,{message:"Summani 2 kasr aniqligida kiriting"})
  .transform(Number);
const positiveShiftMoneySchema = shiftMoneySchema.refine(value=>value>0,{message:"Summa 0 dan katta bo‘lishi kerak"});

const router = Router();
router.use(requireAuth, requireOrganization);
router.use(requireActiveLicense);

function assertShiftControl(user, shift) {
  if (hasPermission(user, "shiftRecon")) return;
  if (String(shift.cashier_id) !== String(user.id)) {
    throw new HttpError(403, "Boshqa kassir smenasini boshqarishga ruxsat yo‘q", "SHIFT_FORBIDDEN");
  }
}

router.get("/:id/summary", requirePermission("moduleShifts"), asyncRoute(async (req, res) => {
  z.string().uuid().parse(req.params.id);
  const summary = await withTransaction(async (client) => {
    const shift = (await client.query(
      "SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 FOR SHARE",
      [req.params.id, req.user.organizationId],
    )).rows[0];
    if (!shift) throw new HttpError(404, "Smena topilmadi");
    assertStoreScope(req.user, shift.store_id);
    assertShiftControl(req.user, shift);
    return {shiftId:shift.id,status:shift.status,...await shiftCashSummary(client,shift)};
  });
  res.set("Cache-Control", "no-store");
  ok(res, {summary});
}));

router.post("/open", requirePermission("moduleShifts"), asyncRoute(async (req, res) => {
  const input = z.object({
    storeId: z.string().uuid(),
    openingCash: shiftMoneySchema.default(0),
    registerId: z.string().uuid().optional(),
    registerKey: z.string().trim().max(80).optional(),
    metadata: z.record(z.string(), z.any()).default({}),
  }).parse(req.body);
  assertStoreScope(req.user, input.storeId);

  const shift = await withTransaction(async (client) => {
    const store = await assertOrganizationStore(client, req.user.organizationId, input.storeId);
    await lockStoreTradingAuthorization(client, {organizationId:req.user.organizationId,storeId:input.storeId});
    await assertEmployeeShiftAvailableWithLock(client, req.user.organizationId, req.user.id, input.storeId);
    const existing = await findOpenBranchShiftWithLock(client, req.user.organizationId, input.storeId);
    if (existing) throw new HttpError(409, "Bu filialda smena allaqachon ochiq", "SHIFT_ALREADY_OPEN");
    const register = await resolveShiftRegister(client,{organizationId:req.user.organizationId,storeId:input.storeId,registerId:input.registerId});
    const registerKey = register.register_key;

    const row = (await client.query(`
      INSERT INTO shifts(organization_id,store_id,cashier_id,register_key,opening_cash,metadata,register_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
      req.user.organizationId, input.storeId, req.user.id, registerKey, input.openingCash, input.metadata, register.id,
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
    amount: positiveShiftMoneySchema,
    reason: z.string().trim().min(2).max(300),
    referenceId: z.string().max(120).default(""),
  }).parse(req.body);

  const result = await withTransaction(async (client) => {
    await lockStoreTradingAuthorization(client,{organizationId:req.user.organizationId});
    // A single shift row lock serializes both duplicate manual attempts and
    // concurrent shift close. Keep closed shifts readable for confirmed replay.
    const shift = (await client.query(
      "SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 FOR UPDATE",
      [req.params.id, req.user.organizationId],
    )).rows[0];
    if (!shift) throw new HttpError(404, "Smena topilmadi");
    assertStoreScope(req.user, shift.store_id);
    await lockStoreTradingAuthorization(client,{organizationId:req.user.organizationId,storeId:shift.store_id});
    assertShiftControl(req.user, shift);
    if (input.referenceId) {
      const previous=(await client.query(`
        SELECT * FROM shift_movements
        WHERE organization_id=$1 AND shift_id=$2 AND source='manual' AND reference_id=$3
        ORDER BY created_at,id LIMIT 1
      `,[req.user.organizationId,shift.id,input.referenceId])).rows[0];
      if(previous) {
        if(previous.type!==input.type||Number(previous.amount)!==input.amount||
          previous.reason!==input.reason||String(previous.created_by)!==String(req.user.id))
          throw new HttpError(409,"Kassa harakati identifikatori boshqa ma’lumot bilan ishlatilgan","SHIFT_MOVEMENT_REPLAY_CONFLICT");
        return {movement:previous,replayed:true};
      }
    }
    if (shift.status!=='open') throw new HttpError(404, "Ochiq smena topilmadi");
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
    return {movement:row,replayed:false};
  });

  ok(res, { movement:result.movement }, result.replayed?200:201);
}));

router.post("/:id/close", requirePermission("moduleShifts"), asyncRoute(async (req, res) => {
  const input = z.object({
    actualCash: shiftMoneySchema,
    expectedCash: z.union([z.string(),z.number()])
      .refine(isSignedMoneyInput,{message:"Kutilgan naqd summa 2 kasr aniqligida bo‘lishi kerak"})
      .transform(Number).optional(),
    metadata: z.record(z.string(), z.any()).default({}),
  }).parse(req.body);

  const shift = await withTransaction(async (client) => {
    await lockStoreTradingAuthorization(client,{organizationId:req.user.organizationId});
    const current = (await client.query(
      "SELECT * FROM shifts WHERE id=$1 AND organization_id=$2 AND status='open' FOR UPDATE",
      [req.params.id, req.user.organizationId],
    )).rows[0];
    if (!current) throw new HttpError(404, "Ochiq smena topilmadi");
    assertStoreScope(req.user, current.store_id);
    await lockStoreTradingAuthorization(client,{organizationId:req.user.organizationId,storeId:current.store_id});
    assertShiftControl(req.user, current);

    const expectedCash = await shiftExpectedCash(client,current);
    if (input.expectedCash !== undefined && sumMoney([input.expectedCash]) !== expectedCash) {
      throw new HttpError(409, "Kassa summasi o'zgardi. Qayta tekshiring.", "SHIFT_CASH_CHANGED", {expectedCash});
    }
    const difference = sumMoney([input.actualCash, -expectedCash]);
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
