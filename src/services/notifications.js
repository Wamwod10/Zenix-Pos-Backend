export async function enqueueNotification(client, { organizationId, storeId = null, eventType, eventId, payload }) {
  await client.query(`INSERT INTO notification_outbox (organization_id,store_id,event_type,event_id,payload)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id,event_type,event_id) DO NOTHING`, [organizationId,storeId,eventType,eventId,payload]);
}

export async function enqueueStockLevelNotification(client, {
  organizationId,
  storeId,
  eventBase,
  productId,
  productName,
  storeName = "",
  before,
  after,
  minStock = 0,
}) {
  const previous = Number(before || 0);
  const current = Number(after || 0);
  const threshold = Math.max(0, Number(minStock || 0));
  if (previous > 0 && current <= 0) {
    await enqueueNotification(client, {
      organizationId,
      storeId,
      eventType: "inventory.out",
      eventId: `${eventBase}:${productId}:out`,
      payload: { productId, productName, storeName, quantity: current, minStock: threshold },
    });
    return;
  }
  if (current > 0 && previous > threshold && current <= threshold) {
    await enqueueNotification(client, {
      organizationId,
      storeId,
      eventType: "inventory.low",
      eventId: `${eventBase}:${productId}:low`,
      payload: { productId, productName, storeName, quantity: current, minStock: threshold },
    });
  }
}
