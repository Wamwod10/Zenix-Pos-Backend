import { addMonths, daysBetween, priceExtraStoreByMonths, BILLING_PLANS } from '../config/billing.js';
import { organizationCalendarDateISO } from '../lib/businessDate.js';

export const EXTRA_DURATIONS = Object.freeze(['UNTIL_LICENSE','MONTHLY','ANNUAL']);

/** Server-authoritative price and dates for a new, independent branch pass. */
export function quoteExtraStore({ duration = 'UNTIL_LICENSE', plan, today, licenseExpiry, count }) {
  if (!EXTRA_DURATIONS.includes(duration)) throw new Error('Invalid extra-store duration');
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Invalid extra-store quantity');
  if (!licenseExpiry || licenseExpiry <= today) throw new Error('Active license required');
  const selectedEndDate = duration === 'MONTHLY' ? addMonths(today,1)
    : duration === 'ANNUAL' ? addMonths(today,12) : licenseExpiry;
  const amount = duration === 'MONTHLY' ? BILLING_PLANS.MONTHLY.extraStoreAmount * count
    : duration === 'ANNUAL' ? BILLING_PLANS.ANNUAL.extraStoreAmount * count
    : priceExtraStoreByMonths(plan,today,licenseExpiry,count);
  return { selectedEndDate, extensionDays:daysBetween(today,selectedEndDate), amount };
}

/** This addition is not persisted to organizations.store_limit: expired passes
 * simply stop contributing, without deleting any store or stock history. */
export async function activeExtraStoreCount(client, organization, today = organizationCalendarDateISO(organization)) {
  const row = (await client.query(`SELECT COALESCE(SUM(quantity),0)::int AS count
    FROM extra_store_entitlements
    WHERE organization_id=$1 AND starts_on<=$2::date AND expires_on>$2::date`,
    [organization.id,today])).rows[0];
  return Number(row?.count||0);
}

export async function effectiveStoreLimit(client, organization, businessDate) {
  return Number(organization.store_limit||0) + await activeExtraStoreCount(client, organization, businessDate);
}

/** A current extra pass does not necessarily cover a *future* license term.
 * Exclude an extra charge only when its entitlement spans that entire term. */
export async function coveredExtraStoreCount(client,organization,periodStart,periodEnd){
  if(!periodStart||!periodEnd||periodEnd<=periodStart)throw new Error('Invalid coverage period');
  const result=await client.query(`SELECT COALESCE(SUM(quantity),0)::int AS count
    FROM extra_store_entitlements
    WHERE organization_id=$1 AND starts_on<=$2::date AND expires_on>=$3::date`,
    [organization.id,periodStart,periodEnd]);
  return Number(result.rows[0]?.count||0);
}

/** Read-only operational preview for an organization that has lost paid passes.
 * Stores are stable-sorted by creation, not changed or deactivated. Owners can
 * decide how to reconcile stock, cashiers and open shifts before enforcing caps.
 */
export async function storeLimitReconciliation(client, organization){
  const capacity=await effectiveStoreLimit(client,organization);
  const {rows}=await client.query(`SELECT id,name,created_at FROM stores
    WHERE organization_id=$1 AND active=true ORDER BY created_at ASC,id ASC`,[organization.id]);
  const excess=Math.max(0,rows.length-capacity);
  return {baseLimit:Number(organization.store_limit||0),effectiveLimit:capacity,activeStores:rows.length,
    overLimit:excess,needsReconciliation:excess>0,
    candidates:excess?rows.slice(capacity).map(store=>({id:store.id,name:store.name})):[],
    automaticClosure:false,automaticTradingRestriction:true,
    tradingRestrictedStoreIds:excess?rows.slice(capacity).map(store=>store.id):[]};
}
