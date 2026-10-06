import { HttpError } from "./http.js";

export const branchRegisterKey = (storeId) => `store:${storeId}`;

export const selectActiveBranchShifts = (shifts, { allowedStoreId = null } = {}) => {
  const active = {};
  for (const shift of shifts || []) {
    if (shift?.status !== "open" || !shift.storeId) continue;
    if (allowedStoreId && String(shift.storeId) !== String(allowedStoreId)) continue;
    const current = active[shift.storeId];
    const openedAt = Date.parse(shift.openedAtISO || shift.opened_at || 0) || 0;
    const currentOpenedAt = Date.parse(current?.openedAtISO || current?.opened_at || 0) || 0;
    if (!current || openedAt > currentOpenedAt) active[shift.storeId] = shift;
  }
  return active;
};

export const findOpenBranchShiftWithLock = async (client, organizationId, storeId) => {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${organizationId}:${storeId}`]);
  return (await client.query(
    "SELECT id FROM shifts WHERE organization_id=$1 AND store_id=$2 AND status='open' ORDER BY opened_at DESC LIMIT 1",
    [organizationId, storeId],
  )).rows[0] || null;
};

export const assertSharedOpenShift = (shift, { organizationId, storeId }) => {
  const valid = shift
    && shift.status === "open"
    && (!shift.organization_id || String(shift.organization_id) === String(organizationId))
    && String(shift.store_id) === String(storeId);
  if (!valid) throw new HttpError(409, "Smena ochiq emas", "SHIFT_REQUIRED");
  return shift;
};
