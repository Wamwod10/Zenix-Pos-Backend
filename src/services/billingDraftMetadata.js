import { BILLING_PLANS } from '../config/billing.js';

/** Payment summaries are reviewed by humans; client-supplied labels must not
 * impersonate a different plan or a larger store allowance. */
export function buildBillingDraftMetadata(input, calculated) {
  const safe = { ...input.metadata };
  delete safe.intent;
  delete safe.purpose;
  delete safe.activeStores;
  return {
    ...safe,
    intent: calculated.intent,
    purpose: calculated.type === 'EXTRA'
      ? `Qo‘shimcha filial limiti · ${calculated.extraStoreCount} ta`
      : `${BILLING_PLANS[calculated.plan]?.label || calculated.plan} tarif`,
    activeStores: calculated.activeStores,
    extraDuration:calculated.type==='EXTRA'?calculated.extraDuration:null,
    ...(calculated.pricingRule?{pricingRule:calculated.pricingRule}:{}),
    promoId:calculated.promoId||null,promoCode:calculated.promoCode||"",promoDiscount:calculated.promoDiscount||0,promoDiscountPercent:calculated.promoDiscountPercent||0,
  };
}
