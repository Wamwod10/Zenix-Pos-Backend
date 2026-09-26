export async function writeAudit(client, {
  organizationId, userId, storeId = null, action, entityType, entityId = null,
  title = "", description = "", before = null, after = null, metadata = {},
}) {
  await client.query(`INSERT INTO audit_logs (organization_id,user_id,store_id,action,entity_type,entity_id,title,description,before_data,after_data,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [organizationId,userId,storeId,action,entityType,entityId,title,description,before,after,metadata]);
}
