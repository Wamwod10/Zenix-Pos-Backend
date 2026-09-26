import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { asyncRoute, HttpError, ok } from "../lib/http.js";
import { requireAuth, requireOrganization, requirePermission, requireActiveLicense } from "../middleware/auth.js";
import { writeAudit } from "../services/audit.js";
import { isBranchLocked } from "../lib/storeScope.js";

const router = Router();
router.use(requireAuth, requireOrganization);
router.use(requireActiveLicense);

const productSchema = z.object({
  name: z.string().trim().min(1).max(240),
  sku: z.string().trim().max(120).default(""),
  barcode: z.string().trim().max(120).default(""),
  category: z.string().trim().max(120).default(""),
  brand: z.string().trim().max(120).default(""),
  unit: z.string().trim().max(40).default("dona"),
  costPrice: z.coerce.number().min(0).default(0),
  sellPrice: z.coerce.number().min(0).default(0),
  wholesalePrice: z.coerce.number().min(0).default(0),
  minStock: z.coerce.number().min(0).default(0),
  metadata: z.record(z.string(), z.any()).default({}),
});

const productAuditSnapshot = (row) => ({
  name: row.name,
  sku: row.sku,
  barcode: row.barcode,
  category: row.category,
  brand: row.brand,
  unit: row.unit,
  costPrice: Number(row.cost_price || 0),
  sellPrice: Number(row.sell_price || 0),
  wholesalePrice: Number(row.wholesale_price || 0),
  minStock: Number(row.min_stock || 0),
  archived: Boolean(row.archived),
});

router.get("/", requirePermission("moduleProducts"), asyncRoute(async (req, res) => {
  const branchStoreId=isBranchLocked(req.user)?req.user.storeId:null;
  const params=branchStoreId?[req.user.organizationId,branchStoreId]:[req.user.organizationId];
  const { rows } = await pool.query(`
    SELECT p.*,
      COALESCE(jsonb_object_agg(ib.store_id,ib.quantity) FILTER(WHERE ib.store_id IS NOT NULL),'{}'::jsonb) stock_by_store
    FROM products p
    LEFT JOIN inventory_balances ib ON ib.product_id=p.id AND ib.organization_id=p.organization_id ${branchStoreId?"AND ib.store_id=$2":""}
    WHERE p.organization_id=$1
    GROUP BY p.id
    ORDER BY p.created_at DESC`, params);
  ok(res, { products: rows });
}));

router.get("/barcode/generate", requirePermission("productWrite"), asyncRoute(async (req, res) => {
  const checksum = (digits) => {
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
  };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const body = `29${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`.slice(0, 12);
    const barcode = body + checksum(body);
    const exists = await pool.query("SELECT 1 FROM products WHERE organization_id=$1 AND barcode=$2 LIMIT 1", [req.user.organizationId, barcode]);
    if (!exists.rowCount) return ok(res, { barcode });
  }
  throw new HttpError(503, "Unikal shtrix-kod yaratib bo‘lmadi. Qayta urinib ko‘ring.", "BARCODE_GENERATION_FAILED");
}));

router.post("/", requirePermission("productWrite"), asyncRoute(async (req, res) => {
  const input = productSchema.parse(req.body);
  const product = await withTransaction(async (client) => {
    const row = (await client.query(`
      INSERT INTO products(organization_id,name,sku,barcode,category,brand,unit,cost_price,sell_price,wholesale_price,min_stock,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`, [
      req.user.organizationId, input.name, input.sku, input.barcode, input.category, input.brand, input.unit,
      input.costPrice, input.sellPrice, input.wholesalePrice, input.minStock, input.metadata,
    ])).rows[0];
    await writeAudit(client, {
      organizationId: req.user.organizationId,
      userId: req.user.id,
      action: "create",
      entityType: "product",
      entityId: row.id,
      title: "Mahsulot qo‘shildi",
      description: row.name,
      after: productAuditSnapshot(row),
    });
    return row;
  });
  ok(res, { product }, 201);
}));

router.patch("/:id", requirePermission("productWrite"), asyncRoute(async (req, res) => {
  const input = productSchema.partial().parse(req.body);
  const product = await withTransaction(async (client) => {
    const current = (await client.query("SELECT * FROM products WHERE id=$1 AND organization_id=$2 FOR UPDATE", [req.params.id, req.user.organizationId])).rows[0];
    if (!current) throw new HttpError(404, "Mahsulot topilmadi");
    const value = {
      name: input.name ?? current.name,
      sku: input.sku ?? current.sku,
      barcode: input.barcode ?? current.barcode,
      category: input.category ?? current.category,
      brand: input.brand ?? current.brand,
      unit: input.unit ?? current.unit,
      costPrice: input.costPrice ?? Number(current.cost_price),
      sellPrice: input.sellPrice ?? Number(current.sell_price),
      wholesalePrice: input.wholesalePrice ?? Number(current.wholesale_price),
      minStock: input.minStock ?? Number(current.min_stock),
      metadata: input.metadata ?? current.metadata,
    };
    const row = (await client.query(`
      UPDATE products SET name=$3,sku=$4,barcode=$5,category=$6,brand=$7,unit=$8,cost_price=$9,sell_price=$10,
        wholesale_price=$11,min_stock=$12,metadata=$13,updated_at=now()
      WHERE id=$1 AND organization_id=$2 RETURNING *`, [
      req.params.id, req.user.organizationId, value.name, value.sku, value.barcode, value.category, value.brand, value.unit,
      value.costPrice, value.sellPrice, value.wholesalePrice, value.minStock, value.metadata,
    ])).rows[0];
    await writeAudit(client, {
      organizationId: req.user.organizationId,
      userId: req.user.id,
      action: "update",
      entityType: "product",
      entityId: row.id,
      title: "Mahsulot tahrirlandi",
      description: row.name,
      before: productAuditSnapshot(current),
      after: productAuditSnapshot(row),
    });
    return row;
  });
  ok(res, { product });
}));

router.post("/:id/restore", requirePermission("productWrite"), asyncRoute(async (req, res) => {
  const product = await withTransaction(async (client) => {
    const current = (await client.query("SELECT * FROM products WHERE id=$1 AND organization_id=$2 FOR UPDATE", [req.params.id, req.user.organizationId])).rows[0];
    if (!current) throw new HttpError(404, "Mahsulot topilmadi");
    if (!current.archived) return current;
    const row = (await client.query("UPDATE products SET archived=false,archived_at=NULL,updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *", [req.params.id, req.user.organizationId])).rows[0];
    await writeAudit(client, {
      organizationId: req.user.organizationId,
      userId: req.user.id,
      action: "restore",
      entityType: "product",
      entityId: row.id,
      title: "Mahsulot tiklandi",
      description: row.name,
      before: productAuditSnapshot(current),
      after: productAuditSnapshot(row),
    });
    return row;
  });
  ok(res, { product });
}));

router.post("/:id/archive", requirePermission("productWrite"), asyncRoute(async (req, res) => {
  const product = await withTransaction(async (client) => {
    const orgId = req.user.organizationId;
    const current = (await client.query("SELECT * FROM products WHERE id=$1 AND organization_id=$2 FOR UPDATE", [req.params.id, orgId])).rows[0];
    if (!current) throw new HttpError(404, "Mahsulot topilmadi");
    if (current.archived) return current;

    const [nonzero, serial, batch, transfer] = await Promise.all([
      client.query("SELECT 1 FROM inventory_balances WHERE organization_id=$1 AND product_id=$2 AND quantity<>0 LIMIT 1", [orgId, current.id]),
      client.query("SELECT 1 FROM product_serials WHERE organization_id=$1 AND product_id=$2 AND status='IN_STOCK' LIMIT 1", [orgId, current.id]),
      client.query("SELECT 1 FROM inventory_batches WHERE organization_id=$1 AND product_id=$2 AND remaining_quantity>0 LIMIT 1", [orgId, current.id]),
      client.query(`SELECT 1 FROM stock_transfer_items sti JOIN stock_transfers st ON st.id=sti.transfer_id
        WHERE st.organization_id=$1 AND sti.product_id=$2 AND st.status IN ('pending','approved','dispatched') LIMIT 1`, [orgId, current.id]),
    ]);
    if (nonzero.rowCount || serial.rowCount || batch.rowCount) throw new HttpError(409, "Qoldig‘i mavjud mahsulotni arxivlab bo‘lmaydi", "PRODUCT_HAS_STOCK");
    if (transfer.rowCount) throw new HttpError(409, "Ochiq transferdagi mahsulotni arxivlab bo‘lmaydi", "PRODUCT_HAS_TRANSFER");

    const row = (await client.query("UPDATE products SET archived=true,archived_at=now(),updated_at=now() WHERE id=$1 AND organization_id=$2 RETURNING *", [current.id, orgId])).rows[0];
    await writeAudit(client, {
      organizationId: orgId,
      userId: req.user.id,
      action: "archive",
      entityType: "product",
      entityId: row.id,
      title: "Mahsulot arxivlandi",
      description: row.name,
      before: productAuditSnapshot(current),
      after: productAuditSnapshot(row),
    });
    return row;
  });
  ok(res, { product });
}));

export default router;
