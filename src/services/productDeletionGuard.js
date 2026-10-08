import { HttpError } from '../lib/http.js';

// Invoked while the product row is locked by the caller's transaction.
// Never silently discard live stock, unconsumed batches or tracked IMEIs,
// even if a legacy import/seed did not leave a stock_movement record.
export async function assertNoLiveProductInventory(client, organizationId, productId) {
  const queries = [
    `SELECT 1 FROM inventory_balances WHERE organization_id=$1 AND product_id=$2 AND quantity<>0 LIMIT 1`,
    `SELECT 1 FROM inventory_batches WHERE organization_id=$1 AND product_id=$2 AND remaining_quantity>0 LIMIT 1`,
    `SELECT 1 FROM product_serials WHERE organization_id=$1 AND product_id=$2 AND status='IN_STOCK' LIMIT 1`,
  ];
  for (const sql of queries) {
    const result = await client.query(sql, [organizationId, productId]);
    if (result.rowCount) {
      throw new HttpError(409,
        'Mahsulotning omborda qoldig‘i, partiyasi yoki faol seriali mavjud. Avval xavfsiz inventarizatsiya qiling.',
        'PRODUCT_HAS_STOCK');
    }
  }
}