import { Router } from "express";
import { z } from "zod";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";

const router = Router();
router.use(requireAuth, requireOrganization);
router.use(requireActiveLicense);

router.post("/", requirePermission("settingsWrite"), asyncRoute(async (req, res) => {
  const { name } = z.object({ name:z.string().trim().min(2).max(120) }).parse(req.body);
  const row = await withTransaction(async (client) => {
    const org = (await client.query("SELECT store_limit FROM organizations WHERE id=$1 FOR UPDATE", [req.user.organizationId])).rows[0];
    const count = Number((await client.query("SELECT count(*) FROM stores WHERE organization_id=$1 AND active=true", [req.user.organizationId])).rows[0].count);
    if (count >= Number(org.store_limit)) throw new HttpError(409, "Tarif bo‘yicha filial limiti tugagan", "STORE_LIMIT");
    const duplicate = await client.query("SELECT 1 FROM stores WHERE organization_id=$1 AND lower(name)=lower($2) LIMIT 1", [req.user.organizationId, name]);
    if (duplicate.rowCount) throw new HttpError(409, "Bu nomdagi filial allaqachon mavjud", "STORE_NAME_EXISTS");
    const store = (await client.query("INSERT INTO stores(organization_id,name) VALUES($1,$2) RETURNING *", [req.user.organizationId, name])).rows[0];
    await writeAudit(client, {
      organizationId:req.user.organizationId,
      userId:req.user.id,
      storeId:store.id,
      action:"create",
      entityType:"store",
      entityId:store.id,
      title:"Filial yaratildi",
      description:name,
    });
    return store;
  });
  ok(res, { store:{ id:row.id, name:row.name, active:row.active } }, 201);
}));

router.patch("/:id", requirePermission("settingsWrite"), asyncRoute(async (req, res) => {
  const input = z.object({
    name:z.string().trim().min(2).max(120).optional(),
    active:z.boolean().optional(),
  }).parse(req.body);
  const id = req.params.id;
  const orgId = req.user.organizationId;

  const row = await withTransaction(async (client) => {
    // Serialize branch lifecycle changes at organization level so two concurrent
    // archive/restore requests cannot bypass the last-store or license limits.
    const org = (await client.query("SELECT id,store_limit FROM organizations WHERE id=$1 FOR UPDATE", [orgId])).rows[0];
    const store = (await client.query("SELECT * FROM stores WHERE id=$1 AND organization_id=$2 FOR UPDATE", [id, orgId])).rows[0];
    if (!store) throw new HttpError(404, "Filial topilmadi");

    if (input.active === true && !store.active) {
      const activeCount = Number((await client.query("SELECT count(*)::int AS count FROM stores WHERE organization_id=$1 AND active=true", [orgId])).rows[0]?.count || 0);
      if (activeCount >= Number(org?.store_limit || 0)) throw new HttpError(409, "Tarif bo‘yicha filial limiti tugagan", "STORE_LIMIT");
    }

    if (input.active === false && store.active) {
      const activeCount = Number((await client.query("SELECT count(*)::int AS count FROM stores WHERE organization_id=$1 AND active=true", [orgId])).rows[0]?.count || 0);
      if (activeCount <= 1) throw new HttpError(409, "Oxirgi faol filialni arxivlab bo‘lmaydi", "LAST_ACTIVE_STORE");

      const [shift, stock, serialStock, batchStock, users, transfer, count] = await Promise.all([
        client.query("SELECT 1 FROM shifts WHERE organization_id=$1 AND store_id=$2 AND status='open' LIMIT 1", [orgId, id]),
        client.query("SELECT 1 FROM inventory_balances WHERE organization_id=$1 AND store_id=$2 AND quantity<>0 LIMIT 1", [orgId, id]),
        client.query("SELECT 1 FROM product_serials WHERE organization_id=$1 AND store_id=$2 AND status IN ('IN_STOCK','IN_TRANSIT') LIMIT 1", [orgId, id]),
        client.query("SELECT 1 FROM inventory_batches WHERE organization_id=$1 AND store_id=$2 AND remaining_quantity>0 LIMIT 1", [orgId, id]),
        client.query("SELECT 1 FROM users WHERE organization_id=$1 AND store_id=$2 AND active=true LIMIT 1", [orgId, id]),
        client.query("SELECT 1 FROM stock_transfers WHERE organization_id=$1 AND status IN ('pending','approved','dispatched') AND (from_store_id=$2 OR to_store_id=$2) LIMIT 1", [orgId, id]),
        client.query("SELECT 1 FROM inventory_counts WHERE organization_id=$1 AND store_id=$2 AND status IN ('draft','review') LIMIT 1", [orgId, id]),
      ]);
      if (shift.rowCount || stock.rowCount || serialStock.rowCount || batchStock.rowCount || users.rowCount || transfer.rowCount || count.rowCount) {
        const details={shift:Boolean(shift.rowCount),stock:Boolean(stock.rowCount||serialStock.rowCount||batchStock.rowCount),users:Boolean(users.rowCount),transfer:Boolean(transfer.rowCount),inventoryCount:Boolean(count.rowCount)};
        const labels=[details.shift&&"ochiq smena",details.stock&&"qoldiq",details.users&&"faol xodim",details.transfer&&"ochiq transfer",details.inventoryCount&&"tugallanmagan inventarizatsiya"].filter(Boolean);
        throw new HttpError(409, `Filialni arxivlashdan oldin quyidagilarni yakunlang: ${labels.join(", ")}`, "STORE_HAS_DEPENDENCIES", details);
      }
    }

    const updated = (await client.query(`UPDATE stores
      SET name=COALESCE($3,name),
          active=COALESCE($4,active),
          archived_at=CASE WHEN $4=false THEN now() WHEN $4=true THEN NULL ELSE archived_at END
      WHERE id=$1 AND organization_id=$2
      RETURNING *`, [id, orgId, input.name ?? null, input.active ?? null])).rows[0];

    const renamed = input.name !== undefined && input.name !== store.name;
    const lifecycleChanged = input.active !== undefined && input.active !== store.active;
    if (renamed || lifecycleChanged) {
      const action = lifecycleChanged ? (updated.active ? "restore" : "archive") : "update";
      const title = lifecycleChanged ? (updated.active ? "Filial tiklandi" : "Filial arxivlandi") : "Filial tahrirlandi";
      await writeAudit(client, {
        organizationId:orgId,
        userId:req.user.id,
        storeId:updated.id,
        action,
        entityType:"store",
        entityId:updated.id,
        title,
        description:updated.name,
        before:{ name:store.name, active:store.active },
        after:{ name:updated.name, active:updated.active },
      });
    }
    return updated;
  });

  ok(res, { store:{ id:row.id, name:row.name, active:row.active } });
}));

export default router;
